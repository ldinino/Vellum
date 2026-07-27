/**
 * Clipboard helpers for the themed context menus (spec Section 5 / Phase 8
 * prerequisite). The native WebView2 menu is suppressed app-wide, so Cut / Copy
 * / Paste are driven from our own menus instead.
 *
 * - Copy/Cut use `document.execCommand` on the focused selection, which fires
 *   ProseMirror's own clipboard serialization (preserving rich content) and
 *   triggers React's onChange for plain inputs.
 * - Paste reads via the async Clipboard API, since `execCommand("paste")` is
 *   blocked in the WebView. The caller decides how to insert what we return.
 */

import { resolveImageSrc, VELLUM_SRC_ATTR } from "../components/editor/ResizableImage";

/** Read the system clipboard, preferring rich HTML; falls back to plain text. */
export async function readClipboard(): Promise<{ html: string | null; text: string }> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      let html: string | null = null;
      let text = "";
      for (const item of items) {
        if (!html && item.types.includes("text/html")) {
          html = await (await item.getType("text/html")).text();
        }
        if (!text && item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
      if (html || text) return { html, text };
    }
  } catch {
    /* permission denied / unsupported — fall back to readText below */
  }
  try {
    return { html: null, text: await navigator.clipboard.readText() };
  } catch {
    return { html: null, text: "" };
  }
}

/** Copy/cut the focused element's current selection (editor or input). */
export function execClipboard(action: "copy" | "cut"): void {
  try {
    document.execCommand(action);
  } catch (e) {
    console.error(`clipboard ${action} failed`, e);
  }
}

// --- Copying inline images OUT of the app -----------------------------------
//
// Inline images are stored as notebook-relative paths (`attachments/<page>/…`)
// and only resolved to a loadable URL at render time, so the HTML ProseMirror
// puts on the clipboard points at something only Vellum can resolve — pasting
// into Teams/Word/a browser yields a broken placeholder. The handler below runs
// after ProseMirror has filled the copy event and rewrites the clipboard with
// every internal image inlined as a `data:` URI; a lone image also gets a real
// `image/png` flavour for apps that take a bitmap rather than HTML. The stored
// path rides along in `data-vellum-src` so an in-app paste keeps referencing the
// file instead of embedding the bytes (see ResizableImage).

/** True for srcs only Vellum can resolve: stored relative paths, and the asset
 * URL the NodeView renders them to (what a non-ProseMirror copy would emit). */
function isInternalImageSrc(src: string): boolean {
  if (!src) return false;
  if (/^(asset:|https?:\/\/asset\.localhost)/i.test(src)) return true;
  // Anything else carrying a scheme (data:, blob:, http:, file:) is already
  // self-contained or externally resolvable — leave it alone.
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
}

async function fetchImageBlob(src: string): Promise<Blob | null> {
  const url = /^(asset:|https?:\/\/asset\.localhost)/i.test(src) ? src : resolveImageSrc(src);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Re-encode to PNG when needed: Chromium rejects a clipboard image whose bytes
 * don't match the declared type. Decoding a same-origin blob keeps the canvas
 * untainted, so this works for JPEG/GIF/WebP screenshots too. */
async function toPngBlob(blob: Blob): Promise<Blob | null> {
  if (blob.type === "image/png") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

/** Swap each image's src for a `data:` URI in place. Returns the first image's
 * bytes (null when nothing could be read, e.g. a file that has gone missing). */
async function inlineImages(imgs: HTMLImageElement[]): Promise<Blob | null> {
  const seen = new Map<string, Blob | null>();
  let first: Blob | null = null;
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    if (!seen.has(src)) seen.set(src, await fetchImageBlob(src));
    const blob = seen.get(src) ?? null;
    if (!blob) continue;
    img.setAttribute(VELLUM_SRC_ATTR, src);
    img.setAttribute("src", await blobToDataUri(blob));
    first ??= blob;
  }
  return first;
}

function enrichCopiedImages(event: ClipboardEvent): void {
  const cd = event.clipboardData;
  if (!cd) return;
  let html = "";
  let text = "";
  try {
    html = cd.getData("text/html");
    text = cd.getData("text/plain");
  } catch {
    return;
  }
  if (!html.includes("<img")) return;

  // An inert document: parsing here never kicks off image loads.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const all = Array.from(doc.querySelectorAll("img"));
  const internal = all.filter((img) => isInternalImageSrc(img.getAttribute("src") ?? ""));
  if (internal.length === 0) return;

  // A bare image copy (right-click ▸ Copy) also gets a bitmap, so Paint, Explorer
  // and apps that ignore HTML paste the picture itself.
  const lone = all.length === 1 && internal.length === 1 && !doc.body.textContent?.trim();

  const job = inlineImages(internal).then(async (blob) => ({
    // Nothing readable → keep exactly what ProseMirror produced.
    html: blob ? doc.body.innerHTML : html,
    png: lone && blob ? await toPngBlob(blob) : null,
  }));

  // Built synchronously with pending values so the write keeps this event's user
  // activation; the browser resolves them before it touches the clipboard.
  const write = (withBitmap: boolean) => {
    const data: Record<string, Promise<Blob>> = {
      "text/html": job.then((r) => new Blob([r.html], { type: "text/html" })),
    };
    if (text) data["text/plain"] = Promise.resolve(new Blob([text], { type: "text/plain" }));
    if (withBitmap) {
      data["image/png"] = job.then((r) => {
        if (!r.png) throw new Error("copied image could not be encoded as PNG");
        return r.png;
      });
    }
    return navigator.clipboard.write([new ClipboardItem(data)]);
  };

  const failed = (e: unknown) => console.error("copy with images failed", e);
  // A rejected write leaves the clipboard as ProseMirror wrote it, so the worst
  // case is the old behaviour. Retry without the bitmap if that was the problem.
  write(lone).catch((e) => (lone ? write(false).catch(failed) : failed(e)));
}

/** Listen for copy/cut app-wide so inline images survive a paste into another
 * application. Returns a disposer. */
export function installImageCopySupport(): () => void {
  const handler = (e: ClipboardEvent) => enrichCopiedImages(e);
  document.addEventListener("copy", handler);
  document.addEventListener("cut", handler);
  return () => {
    document.removeEventListener("copy", handler);
    document.removeEventListener("cut", handler);
  };
}
