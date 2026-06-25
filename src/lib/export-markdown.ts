/**
 * Page → Markdown export (spec Section 14, Phase 10).
 *
 * Converts the open page's editor HTML to Markdown and copies its inline images
 * and attachments into a sibling `<name> files/` folder next to the chosen `.md`
 * (the backend `export_page` command owns the filesystem writes). The result is
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

/** Filename of a save-dialog path, without its `.md` extension. */
function mdBaseName(p: string): string {
  return baseName(p).replace(/\.md$/i, "");
}

/** True for srcs that are real files under the notebook dir (so they're copied);
 * false for external/self-contained URLs left untouched. Mirrors the editor's
 * image src resolver (ResizableImage). */
function isCopyable(src: string): boolean {
  return !/^(https?:|data:|asset:|blob:|file:|http:\/\/asset)/i.test(src);
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

  // Rewrite inline-image links to the export's files folder (keep external as-is).
  // An explicit width is preserved via an HTML <img> (Markdown can't size images).
  td.addRule("exportImage", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      const dest = imageMap.get(src);
      const target = dest ? `./${filesDirName}/${dest}` : src;
      const width = el.getAttribute("width");
      if (width) return `<img src="${target}" alt="${alt}" width="${width}">`;
      // Angle-bracket the target so spaces in the folder name stay valid.
      return `![${alt}](<${target}>)`;
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
    attachLinks.push(`- [${a.filename}](<./${filesDirName}/${dest}>)`);
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

    // Sanitize the same way the backend does, so the links baked into the
    // Markdown match the folder it actually creates next to the .md.
    const stem = sanitizeFilename(mdBaseName(mdPath)) || "export";
    const filesDirName = `${stem} files`;
    const { markdown, copies } = buildExport({ html, doc, title, attachments, filesDirName });
    await api.exportPage(notebookId, mdPath, markdown, filesDirName, copies);
  } catch (e) {
    onError?.(typeof e === "string" ? e : `Export failed: ${String(e)}`);
  }
}
