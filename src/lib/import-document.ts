/**
 * Document → editor JSON import (execution-plan #4). The mirror of
 * lib/export-markdown.ts: this module owns the *conversion* (a picked document
 * becomes a Tiptap document), while the backend owns the filesystem reads
 * (`import_read_file` / `import_scan_folder` / `import_copy_external_image`) and
 * the normal `create_page` / `save_page_snapshot` commands do the writing.
 *
 * Formats: Markdown (`.md`/`.markdown`), HTML (`.html`/`.htm`), plain text
 * (`.txt`) — all via `markdown-it` + Tiptap's `generateJSON`, no extra deps —
 * and Word (`.docx`) via a lazily-imported `mammoth`. Everything is parsed
 * through the editor schema (`buildExtensions()`), which allow-lists nodes/marks
 * and drops anything unknown, so imported HTML can never inject script or
 * unexpected attributes into the document (belt-and-suspenders with the explicit
 * scheme sanitising below — model/document input is untrusted).
 */

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { generateJSON, type JSONContent } from "@tiptap/react";

/** A document type Vellum can import. */
export type ImportFormat = "markdown" | "html" | "text" | "docx";

/** File extensions Vellum can import (kept in sync with the backend's
 * `IMPORT_EXTS`). Lowercase, no leading dot — used for the file-dialog filter. */
export const IMPORT_EXTENSIONS = ["md", "markdown", "html", "htm", "txt", "docx"];

/** Map a file extension (no dot, any case) to its import format, or null. */
export function formatForExt(ext: string): ImportFormat | null {
  switch (ext.toLowerCase()) {
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    case "txt":
      return "text";
    case "docx":
      return "docx";
    default:
      return null;
  }
}

// --- Markdown --------------------------------------------------------------

let mdParser: MarkdownIt | null = null;
function markdownParser(): MarkdownIt {
  if (!mdParser) {
    // `html: true` keeps the inline HTML our exporter emits for formatting
    // Markdown can't express (highlight, sup/sub, underline, colour, alignment)
    // and the `<img>` we synthesise for ADO image sizes below. Safe *only*
    // because everything is re-parsed through the Tiptap schema, which drops
    // anything not in buildExtensions().
    mdParser = new MarkdownIt({ html: true, linkify: true, typographer: false });
    mdParser.use(taskLists);
  }
  return mdParser;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * Rewrite Vellum/ADO Markdown that `markdown-it` won't parse natively:
 *  - image size `![alt](src =WIDTHx)` → an `<img>` with a `width` (markdown-it
 *    treats the ` =300x` suffix as an invalid title and drops the whole image).
 *    The `src` is left percent-encoded; the backend decodes it when re-homing.
 *  - standalone `[[_TOC_]]` directive lines (an Azure DevOps wiki token, not
 *    content) are removed.
 */
function preprocessMarkdown(src: string): string {
  let out = src.replace(/^[ \t]*\[\[_TOC_\]\][ \t]*$/gim, "");
  out = out.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+?)\s+=(\d+)x\)/g,
    (_m, alt: string, encSrc: string, width: string) =>
      `<img src="${escapeAttr(encSrc)}" alt="${escapeAttr(alt)}" width="${width}">`,
  );
  return out;
}

function renderMarkdownToHtml(src: string): string {
  return markdownParser().render(preprocessMarkdown(src));
}

// --- Plain text ------------------------------------------------------------

function textToHtml(text: string): string {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

// --- DOCX (lazy) -----------------------------------------------------------

/** A modern `.docx` is an Office Open XML package — i.e. a Zip, whose local file
 * header is `PK\x03\x04`. If the bytes are something else, return a clear message
 * instead of letting mammoth fail deep inside its unzip with the cryptic JSZip
 * "Can't find end of central directory" error. The usual culprit is an OLE2
 * compound file (magic `D0 CF 11 E0`): most often a `.docx` encrypted by a
 * Microsoft sensitivity / DLP label (e.g. marked "Confidential"), or a legacy
 * Word 97–2003 `.doc` renamed to `.docx`. Returns null when the header looks
 * like a valid Zip. */
function docxFormatError(ab: ArrayBuffer): string | null {
  const u8 = new Uint8Array(ab);
  const is = (...sig: number[]) => sig.every((b, i) => u8[i] === b);
  // Zip local-file / empty-archive / spanned headers — a real .docx.
  if (is(0x50, 0x4b, 0x03, 0x04) || is(0x50, 0x4b, 0x05, 0x06) || is(0x50, 0x4b, 0x07, 0x08)) {
    return null;
  }
  if (is(0xd0, 0xcf, 0x11, 0xe0)) {
    return (
      "This “.docx” can’t be read because it’s a protected or legacy Office file. " +
      "Most often it’s encrypted by a sensitivity or DLP label (e.g. marked " +
      "“Confidential”) — in Word, set the sensitivity label to “General” (or save " +
      "an unprotected copy), then import again. A legacy Word 97–2003 “.doc” " +
      "renamed to “.docx” has the same effect; re-save it as “.docx”."
    );
  }
  return "This file isn’t a valid Word “.docx” document (it isn’t an Office Open XML package).";
}

/** Convert a `.docx` to semantic HTML with `mammoth`, loaded on demand so its
 * sizeable bundle never ships unless someone imports Word (in the spirit of
 * Mermaid's lazy chunks). Embedded images arrive as `data:` URIs, which the
 * re-homing step turns into page files. */
async function docxToHtml(bytes: ArrayBuffer): Promise<string> {
  const formatError = docxFormatError(bytes);
  if (formatError) throw new Error(formatError);
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
  return result.value;
}

// --- HTML → Tiptap document ------------------------------------------------

/** Rewrite `markdown-it-task-lists` output (`<ul class="contains-task-list">` /
 * `<li class="task-list-item"><input type=checkbox>`) into the shape Tiptap's
 * TaskList/TaskItem parse (`data-type` + `data-checked`), preserving the checked
 * state that a plain schema parse would otherwise discard with the input. */
function normalizeTaskLists(html: string): string {
  if (!html.includes("contains-task-list")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("ul.contains-task-list, ol.contains-task-list").forEach((list) => {
    list.setAttribute("data-type", "taskList");
  });
  doc.querySelectorAll("li.task-list-item").forEach((li) => {
    const cb = li.querySelector('input[type="checkbox"]');
    li.setAttribute("data-type", "taskItem");
    li.setAttribute("data-checked", cb?.hasAttribute("checked") ? "true" : "false");
    cb?.remove();
    // Unwrap any <label> wrapper (the `label` option), keeping its children.
    li.querySelectorAll("label").forEach((label) => {
      while (label.firstChild) label.parentNode?.insertBefore(label.firstChild, label);
      label.remove();
    });
  });
  return doc.body.innerHTML;
}

async function htmlToDoc(html: string): Promise<JSONContent> {
  // Loaded on demand so the editor's full extension set (and Mermaid's chunks)
  // aren't pulled in until an import actually runs.
  const { buildExtensions } = await import("../components/editor/extensions");
  return generateJSON(normalizeTaskLists(html), buildExtensions()) as JSONContent;
}

// --- Post-processing (mermaid, sanitise, title) ----------------------------

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

/** Turn a fenced ```mermaid code block (parsed as a `codeBlock` with
 * `language: "mermaid"`) into a `mermaidDiagram` node, so an exported diagram
 * round-trips back to a live diagram instead of a code listing. */
function convertMermaidCodeBlocks(node: JSONContent): JSONContent {
  if (node.type === "codeBlock" && node.attrs?.language === "mermaid") {
    return { type: "mermaidDiagram", attrs: { source: textOf(node).replace(/\n+$/, "") } };
  }
  if (node.content) {
    return { ...node, content: node.content.map(convertMermaidCodeBlocks) };
  }
  return node;
}

function isDangerousUrl(url: string): boolean {
  return /^\s*(javascript|vbscript):/i.test(url);
}
function isAllowedImageSrc(src: string): boolean {
  const s = src.trim();
  if (isDangerousUrl(s)) return false;
  // Allow image data URIs (re-homed to files) but reject any other `data:`
  // (e.g. `data:text/html`) as an image source.
  if (/^data:/i.test(s)) return /^data:image\//i.test(s);
  return true;
}

/** Drop unsafe URL schemes the schema would otherwise keep: `javascript:` /
 * `vbscript:` link targets, and non-image `data:` (or scripting) image sources.
 * Untrusted-input hardening — `mammoth` does no sanitising and `markdown-it`
 * with `html:true` can carry such targets through. */
function sanitizeDoc(node: JSONContent): JSONContent {
  let next = node;
  if (Array.isArray(node.marks)) {
    const marks = node.marks.filter(
      (m) => !(m.type === "link" && typeof m.attrs?.href === "string" && isDangerousUrl(m.attrs.href)),
    );
    next = { ...next, marks };
  }
  if (next.content) {
    const content = next.content
      .filter((c) => !(c.type === "image" && typeof c.attrs?.src === "string" && !isAllowedImageSrc(c.attrs.src)))
      .map(sanitizeDoc);
    next = { ...next, content };
  }
  return next;
}

/** Take the document's leading `# H1` as the page title (and remove it from the
 * body so the title isn't duplicated). Returns a null title when there's no
 * leading H1 — the caller falls back to the filename. */
function extractTitle(doc: JSONContent): { title: string | null; doc: JSONContent } {
  const content = doc.content ?? [];
  const idx = content.findIndex((n) => textOf(n).trim() !== "" || n.type === "image");
  const first = idx >= 0 ? content[idx] : undefined;
  if (first && first.type === "heading" && first.attrs?.level === 1) {
    const title = textOf(first).trim();
    if (title) {
      const rest = [...content.slice(0, idx), ...content.slice(idx + 1)];
      return { title, doc: { ...doc, content: rest } };
    }
  }
  return { title: null, doc };
}

function ensureNonEmpty(doc: JSONContent): JSONContent {
  if (!doc.content || doc.content.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return doc;
}

/** UTF-8 decode the bytes of a text-based document (a leading BOM is stripped). */
function decodeText(ab: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(new Uint8Array(ab));
}

/** Byte payload as returned by `importReadFile`: an `ArrayBuffer` (via
 * `tauri::ipc::Response`) in the normal case, but a typed array or a plain
 * `number[]` are tolerated too so a stale/alternate IPC transport can't silently
 * break binary formats (a `Vec<u8>` command return arrives as a `number[]`). */
export type ImportBytes = ArrayBuffer | ArrayBufferView | number[];

/** Normalize any byte payload into a tightly-sized `ArrayBuffer`. */
export function toArrayBuffer(bytes: ImportBytes): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  return new Uint8Array(bytes).buffer;
}

/** A short description of a byte payload for diagnostics: its JS type, byte
 * length, and first bytes as hex — a `.docx`/zip begins with `50 4b 03 04`
 * ("PK\x03\x04"), so a wrong header pinpoints a corrupted transfer. */
export function describeBytes(bytes: ImportBytes): string {
  const u8 = new Uint8Array(toArrayBuffer(bytes));
  const head = Array.from(u8.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const type = bytes instanceof ArrayBuffer
    ? "ArrayBuffer"
    : ArrayBuffer.isView(bytes)
      ? bytes.constructor.name
      : Array.isArray(bytes)
        ? "Array"
        : typeof bytes;
  return `type=${type} bytes=${u8.length} head=[${head}]`;
}

/**
 * Convert a document's bytes to a Tiptap document plus an optional H1-derived
 * title. Pure aside from the lazy `mammoth` import for DOCX; the caller creates
 * the page, re-homes the images, and saves.
 */
export async function convertDocument(
  format: ImportFormat,
  bytes: ImportBytes,
): Promise<{ title: string | null; doc: JSONContent }> {
  const ab = toArrayBuffer(bytes);
  let html: string;
  switch (format) {
    case "markdown":
      html = renderMarkdownToHtml(decodeText(ab));
      break;
    case "html":
      html = decodeText(ab);
      break;
    case "text":
      html = textToHtml(decodeText(ab));
      break;
    case "docx":
      html = await docxToHtml(ab);
      break;
  }
  let doc = convertMermaidCodeBlocks(await htmlToDoc(html));
  doc = sanitizeDoc(doc);
  const { title, doc: trimmed } = extractTitle(ensureNonEmpty(doc));
  return { title, doc: ensureNonEmpty(trimmed) };
}

// --- Images ----------------------------------------------------------------

/** Extension for an image data-URI MIME type. */
function mimeToExt(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

/** Decode a `data:image/...` URI into bytes + a file extension, or null if it
 * isn't a (base64) image data URI. */
export function decodeDataUri(src: string): { bytes: number[]; ext: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(src.trim());
  if (!m) return null;
  const mime = (m[1] ?? "").toLowerCase();
  if (!mime.startsWith("image/")) return null;
  let binary: string;
  try {
    binary = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  } catch {
    return null;
  }
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return { bytes, ext: mimeToExt(mime) };
}

/**
 * Walk the document's image nodes and rewrite each `src` via `rehome` (which
 * copies the file into the page and returns the new notebook-relative path, or
 * null to leave the src unchanged — e.g. an external URL).
 */
export async function rehomeImages(
  doc: JSONContent,
  rehome: (src: string) => Promise<string | null>,
): Promise<JSONContent> {
  async function visit(node: JSONContent): Promise<JSONContent> {
    let next = node;
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const newSrc = await rehome(node.attrs.src);
      if (newSrc) next = { ...node, attrs: { ...node.attrs, src: newSrc } };
    }
    if (next.content && next.content.length > 0) {
      const content: JSONContent[] = [];
      for (const child of next.content) content.push(await visit(child));
      next = { ...next, content };
    }
    return next;
  }
  return visit(doc);
}

/** First-line preview of a document (mirrors PageEditor's `derivePreview`). */
export function docPreview(doc: JSONContent): string {
  return (doc.content ?? [])
    .map(textOf)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
