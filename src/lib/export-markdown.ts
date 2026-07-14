/**
 * Page → Markdown export (spec Section 14, Phase 10).
 *
 * Converts the open page's editor HTML to Markdown and copies its inline images
 * and attachments into a sibling `.attachments/` folder next to the chosen `.md`
 * (the Azure DevOps wiki convention; the backend `export_page` command owns the
 * filesystem writes). The result is
 * WYSIWYG: formatting Markdown can't express (highlight, super/subscript,
 * underline, text colour, font family/size, block alignment) is preserved as
 * inline HTML, which is still valid Markdown and renders in most viewers.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { save } from "@tauri-apps/plugin-dialog";
import type { Editor, JSONContent } from "@tiptap/react";
import * as api from "../data/api";
import type { Attachment, ExportCopy } from "../data/types";

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

function makeTurndown(filesDirName: string, imageMap: Map<string, string>): TurndownService {
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
      const target = dest ? `./${filesDirName}/${dest}` : src;
      const w = parseInt(el.getAttribute("width") ?? "", 10);
      const size = Number.isFinite(w) ? ` =${w}x` : "";
      return `![${alt}](${encodePath(target)}${size})`;
    },
  });

  return td;
}

/** Build the Markdown document + the list of files to copy alongside it. */
function buildExport(opts: {
  html: string;
  doc: JSONContent;
  title: string;
  attachments: Attachment[];
  filesDirName: string;
}): { markdown: string; copies: ExportCopy[] } {
  const { html, doc, title, attachments, filesDirName } = opts;
  const used = new Set<string>();
  const copies: ExportCopy[] = [];

  // One copy per distinct inline-image source; both refs share the dest name.
  const imageMap = new Map<string, string>();
  for (const src of collectImageSrcs(doc)) {
    if (!isCopyable(src) || imageMap.has(src)) continue;
    const dest = uniqueName(baseName(src), used);
    imageMap.set(src, dest);
    copies.push({ srcRel: src, destName: dest });
  }

  const body = makeTurndown(filesDirName, imageMap).turndown(html).trim();

  // Attachment-bar files: copied into the same folder and listed at the end.
  const attachLinks: string[] = [];
  for (const a of attachments) {
    const dest = uniqueName(a.filename, used);
    copies.push({ srcRel: a.path, destName: dest });
    attachLinks.push(`- [${a.filename}](${encodePath(`./${filesDirName}/${dest}`)})`);
  }

  let markdown = `# ${title.trim() || "Untitled"}\n\n${body}\n`;
  if (attachLinks.length) {
    markdown += `\n## Attachments\n\n${attachLinks.join("\n")}\n`;
  }
  return { markdown, copies };
}

/**
 * Export the open page: prompt for a `.md` location, then write the Markdown and
 * copy its images/attachments into a sibling `<name> files/` folder. No-ops if
 * the user cancels the save dialog; surfaces failures via `onError`.
 */
export async function exportCurrentPage(opts: {
  editor: Editor;
  notebookId: string;
  pageId: string;
  title: string;
  onError?: (message: string) => void;
}): Promise<void> {
  const { editor, notebookId, pageId, title, onError } = opts;
  try {
    const html = editor.getHTML();
    const doc = editor.getJSON();
    const attachments = await api.listAttachments(notebookId, pageId);

    const mdPath = await save({
      defaultPath: `${sanitizeFilename(title) || "Untitled"}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!mdPath) return; // cancelled

    // Azure DevOps wiki convention: one shared `.attachments/` folder next to the
    // .md. The backend re-creates this exact name (preserving the leading dot).
    const filesDirName = ".attachments";
    const { markdown, copies } = buildExport({ html, doc, title, attachments, filesDirName });
    await api.exportPage(notebookId, mdPath, markdown, filesDirName, copies);
  } catch (e) {
    onError?.(typeof e === "string" ? e : `Export failed: ${String(e)}`);
  }
}
