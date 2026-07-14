/**
 * Page → Markdown export (spec Section 14; execution-plan #6 wizard).
 *
 * Converts a page's editor HTML to Markdown and copies its inline images and
 * attachments into an `.attachments/` folder (the Azure DevOps wiki convention;
 * the backend `export_page` / `export_batch` commands own the filesystem writes).
 * A single-file export drops `.attachments/` next to the chosen `.md`; a
 * multi-page export lays pages out as `<Notebook>/<Section>/<Page>.md` under a
 * chosen folder with one shared `.attachments/` at its root. The result is
 * WYSIWYG: formatting Markdown can't express (highlight, super/subscript,
 * underline, text colour, font family/size, block alignment) is preserved as
 * inline HTML, which is still valid Markdown and renders in most viewers.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { generateHTML, type Extensions, type JSONContent } from "@tiptap/react";
import * as api from "../data/api";
import { buildExtensions } from "../components/editor/extensions";
import type { Attachment, ExportCopy, ExportPageEntry } from "../data/types";

/** Strip characters that are invalid in Windows file/folder names. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
}

/** Last path segment of a notebook-relative path (the bare filename). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** True for srcs that are real files under the notebook dir (so they're copied);
 * false for external/self-contained URLs left untouched. Mirrors the editor's
 * image src resolver (ResizableImage). */
function isCopyable(src: string): boolean {
  return !/^(https?:|data:|asset:|blob:|file:|http:\/\/asset)/i.test(src);
}

/** Percent-encode the characters in an export path that would otherwise break
 * Markdown image/link syntax — spaces and parentheses (the latter close the
 * `(...)` target, and both interfere with the ADO image-size suffix). Path
 * separators and other characters are left intact so the path stays readable. */
function encodePath(p: string): string {
  return p.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Reserve a collision-free destination filename within the files folder. */
function uniqueName(name: string, used: Set<string>): string {
  const safe = sanitizeFilename(name) || "file";
  const key = (s: string) => s.toLowerCase();
  if (!used.has(key(safe))) {
    used.add(key(safe));
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let i = 2;
  let candidate = `${stem} (${i})${ext}`;
  while (used.has(key(candidate))) {
    i += 1;
    candidate = `${stem} (${i})${ext}`;
  }
  used.add(key(candidate));
  return candidate;
}

/** Collect every image node's `src` from the Tiptap document, in order. */
function collectImageSrcs(doc: JSONContent): string[] {
  const out: string[] = [];
  const visit = (n: JSONContent) => {
    if (n.type === "image" && typeof n.attrs?.src === "string") out.push(n.attrs.src);
    n.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

/** Rebuild an element's open/close tags around already-converted content, so the
 * inner Markdown is kept while the tag + its attributes (style/colour) survive. */
function reTag(el: HTMLElement, content: string): string {
  const tag = el.nodeName.toLowerCase();
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.name}="${a.value}"`)
    .join(" ");
  return attrs ? `<${tag} ${attrs}>${content}</${tag}>` : `<${tag}>${content}</${tag}>`;
}

function makeTurndown(linkBase: string, imageMap: Map<string, string>): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  td.use(gfm); // tables, strikethrough, task lists

  // Preserve inline formatting Markdown can't express (user choice: keep as HTML).
  td.addRule("keepStyledInline", {
    filter: (node) => {
      const tag = node.nodeName.toLowerCase();
      if (tag === "mark" || tag === "sup" || tag === "sub" || tag === "u") return true;
      return tag === "span" && !!node.getAttribute("style");
    },
    replacement: (content, node) => reTag(node as HTMLElement, content),
  });

  // Preserve block alignment as a styled wrapper, re-adding heading markers so an
  // aligned heading stays a heading.
  td.addRule("alignedBlock", {
    filter: (node) => {
      const tag = node.nodeName.toLowerCase();
      const align = (node as HTMLElement).style?.textAlign;
      return /^(p|h[1-6])$/.test(tag) && !!align && align !== "left" && align !== "start";
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const align = el.style.textAlign;
      const m = /^h([1-6])$/.exec(el.nodeName.toLowerCase());
      const inner = m ? `${"#".repeat(Number(m[1]))} ${content}` : content;
      return `\n\n<div style="text-align: ${align}">\n\n${inner}\n\n</div>\n\n`;
    },
  });

  // Task lists → ADO/GFM checklist syntax (`- [ ]` / `- [x]`). Tiptap renders a task
  // item as `<li data-type="taskItem" data-checked>` wrapping a <label><input> and a
  // <div>, which turndown-plugin-gfm's checkbox rule doesn't recognise (it expects the
  // checkbox directly inside the <li>), so handle the item explicitly.
  td.addRule("taskListItem", {
    filter: (node) =>
      node.nodeName === "LI" && (node as HTMLElement).getAttribute("data-type") === "taskItem",
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const checked = el.getAttribute("data-checked") === "true";
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "")
        .replace(/\n{2,}/g, "\n")
        .replace(/\n/g, "\n  "); // indent any nested checklist under the item
      return `- [${checked ? "x" : " "}] ${body}${el.nextSibling ? "\n" : ""}`;
    },
  });
  // The checkbox <input> carries no text; its state is read from the item above.
  td.addRule("taskCheckbox", {
    filter: (node) =>
      node.nodeName === "INPUT" && (node as HTMLInputElement).type === "checkbox",
    replacement: () => "",
  });

  // Mermaid diagrams export to a ```mermaid fenced block (portable — renders on
  // Azure DevOps wikis and GitHub). The source lives in a data attribute (kept
  // whole; turndown would collapse whitespace in element text).
  td.addRule("mermaidDiagram", {
    filter: (node) =>
      node.nodeName === "DIV" && (node as HTMLElement).getAttribute("data-type") === "mermaid",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = (el.getAttribute("data-source") ?? el.textContent ?? "").trim();
      return `\n\n\`\`\`mermaid\n${src}\n\`\`\`\n\n`;
    },
  });

  // Inline images export to Azure DevOps wiki syntax: `![alt](path =WIDTHx)` — the
  // image-size extension (space before `=`, no space around `x`, trailing `x` for a
  // width-only size, which is all ResizableImage stores). External srcs are left as-is.
  // Spaces/parentheses in the path are percent-encoded (not angle-bracketed) so the
  // size suffix parses, matching ADO's documented plain form.
  td.addRule("exportImage", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      const dest = imageMap.get(src);
      const target = dest ? `${linkBase}/${dest}` : src;
      const w = parseInt(el.getAttribute("width") ?? "", 10);
      const size = Number.isFinite(w) ? ` =${w}x` : "";
      return `![${alt}](${encodePath(target)}${size})`;
    },
  });

  return td;
}

/**
 * Convert one page's editor HTML + document to Markdown, collecting the files it
 * references (inline images + attachments). `linkBase` is the relative path from
 * the `.md` to the shared attachments folder (`./.attachments` for a single-file
 * export, `../../.attachments` inside a `Notebook/Section/Page.md` bundle). Pass
 * a shared `used` set to dedupe destination filenames across a whole batch.
 */
export function renderPageToMarkdown(opts: {
  html: string;
  doc: JSONContent;
  title: string;
  attachments: Attachment[];
  linkBase: string;
  used?: Set<string>;
}): { markdown: string; copies: ExportCopy[] } {
  const { html, doc, title, attachments, linkBase } = opts;
  const used = opts.used ?? new Set<string>();
  const copies: ExportCopy[] = [];

  // One copy per distinct inline-image source; both refs share the dest name.
  const imageMap = new Map<string, string>();
  for (const src of collectImageSrcs(doc)) {
    if (!isCopyable(src) || imageMap.has(src)) continue;
    const dest = uniqueName(baseName(src), used);
    imageMap.set(src, dest);
    copies.push({ srcRel: src, destName: dest });
  }

  const body = makeTurndown(linkBase, imageMap).turndown(html).trim();

  // Attachment-bar files: copied into the same folder and listed at the end.
  const attachLinks: string[] = [];
  for (const a of attachments) {
    const dest = uniqueName(a.filename, used);
    copies.push({ srcRel: a.path, destName: dest });
    attachLinks.push(`- [${a.filename}](${encodePath(`${linkBase}/${dest}`)})`);
  }

  let markdown = `# ${title.trim() || "Untitled"}\n\n${body}\n`;
  if (attachLinks.length) {
    markdown += `\n## Attachments\n\n${attachLinks.join("\n")}\n`;
  }
  return { markdown, copies };
}

/** The empty ProseMirror document (a page with no saved content). */
const EMPTY_DOC: JSONContent = { type: "doc", content: [] };

/** Load a (possibly not-open) page's saved content and derive the inputs the
 * Markdown renderer needs. Content is read from the store, so flush the open
 * page's pending edits before exporting it. */
async function loadPageMarkdownInputs(
  notebookId: string,
  pageId: string,
  extensions: Extensions,
): Promise<{ html: string; doc: JSONContent; attachments: Attachment[] }> {
  const json = await api.loadPageContent(notebookId, pageId);
  const doc: JSONContent = json ? (JSON.parse(json) as JSONContent) : EMPTY_DOC;
  const html = generateHTML(doc, extensions);
  const attachments = await api.listAttachments(notebookId, pageId).catch(() => []);
  return { html, doc, attachments };
}

/** Insert Azure DevOps's `[[_TOC_]]` table-of-contents token just below a page's
 * H1 (inert plain text in other Markdown viewers). */
function insertToc(markdown: string): string {
  const nl = markdown.indexOf("\n");
  return nl < 0
    ? `${markdown}\n\n[[_TOC_]]\n`
    : `${markdown.slice(0, nl)}\n\n[[_TOC_]]${markdown.slice(nl)}`;
}

/** Reserve a collision-free `<dir>/<title>.md` path within a batch. */
function uniqueMdPath(dir: string, title: string, used: Set<string>): string {
  const stem = sanitizeFilename(title) || "Untitled";
  const key = (s: string) => `${dir}/${s}`.toLowerCase();
  let name = stem;
  let i = 1;
  while (used.has(key(name))) {
    i += 1;
    name = `${stem} (${i})`;
  }
  used.add(key(name));
  return `${dir}/${name}.md`;
}

/**
 * Export a single page to a chosen `.md` path, copying its images/attachments
 * into a sibling `.attachments/` folder (the caller obtains `mdPath` from a save
 * dialog). Content is read from the store — flush the page first if it's open.
 */
export async function exportSinglePageToFile(opts: {
  notebookId: string;
  pageId: string;
  title: string;
  mdPath: string;
}): Promise<void> {
  const { notebookId, pageId, title, mdPath } = opts;
  const { html, doc, attachments } = await loadPageMarkdownInputs(
    notebookId,
    pageId,
    buildExtensions(),
  );
  const { markdown, copies } = renderPageToMarkdown({
    html,
    doc,
    title,
    attachments,
    linkBase: "./.attachments",
  });
  await api.exportPage(notebookId, mdPath, markdown, ".attachments", copies);
}

/**
 * Export many pages under `destDir` as `<Notebook>/<Section>/<Page>.md`, with one
 * shared `.attachments/` folder at the root (the ADO wiki layout). Attachment
 * filenames are deduped across the whole batch. Returns the number of pages
 * written. Content is read from the store — flush the open page first.
 */
export async function exportPagesToFolder(opts: {
  notebookId: string;
  notebookName: string;
  destDir: string;
  pages: { pageId: string; title: string; sectionName: string }[];
  includeToc: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<number> {
  const { notebookId, notebookName, destDir, pages, includeToc, onProgress } = opts;
  const extensions = buildExtensions();
  const usedFiles = new Set<string>(); // shared attachment-filename dedupe
  const usedMd = new Set<string>(); // dedupe .md paths (same title within a section)
  const nbFolder = sanitizeFilename(notebookName) || "Notebook";
  const entries: ExportPageEntry[] = [];

  let done = 0;
  for (const p of pages) {
    const { html, doc, attachments } = await loadPageMarkdownInputs(notebookId, p.pageId, extensions);
    const { markdown, copies } = renderPageToMarkdown({
      html,
      doc,
      title: p.title,
      attachments,
      linkBase: "../../.attachments",
      used: usedFiles,
    });
    const secFolder = sanitizeFilename(p.sectionName) || "Section";
    entries.push({
      relPath: uniqueMdPath(`${nbFolder}/${secFolder}`, p.title, usedMd),
      markdown: includeToc ? insertToc(markdown) : markdown,
      copies,
    });
    onProgress?.((done += 1), pages.length);
  }
  return api.exportBatch(notebookId, destDir, ".attachments", entries);
}
