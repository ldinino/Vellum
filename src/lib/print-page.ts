/**
 * Print the open page by rendering ONLY its content (title, body, attachment
 * list) into an isolated hidden iframe and printing that document — so the app
 * chrome (window frame, menus, toolbar, nav, tabs, page strip) never reaches the
 * printer. This replaces a `@media print` stylesheet over the live window, which
 * proved unreliable in the transparent WebView2 window (it printed the whole UI).
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { Editor } from "@tiptap/react";
import * as api from "../data/api";
import { renderMermaid } from "../components/editor/MermaidDiagram";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/** Print-document styles — a self-contained echo of the editor's `.v-prose`
 * look, tuned for paper (black text, page margins, bordered tables). */
const PRINT_CSS = `
  * { box-sizing: border-box; }
  @page { margin: 16mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Segoe UI Variable", Tahoma, Arial, sans-serif;
    font-size: 12pt; line-height: 1.5; color: #000;
  }
  .v-print-title { font-size: 1.8em; font-weight: 600; margin: 0 0 0.5em; }
  .v-print-attachments { margin: 0 0 1em; padding-left: 1.4em; color: #222; }
  .v-print-attachments li { margin: 0.1em 0; }
  .v-print-content > * + * { margin-top: 0.6em; }
  .v-print-content h1 { font-size: 1.7em; font-weight: 600; }
  .v-print-content h2 { font-size: 1.4em; font-weight: 600; }
  .v-print-content h3 { font-size: 1.2em; font-weight: 600; }
  .v-print-content h4 { font-size: 1.05em; font-weight: 600; }
  .v-print-content ul, .v-print-content ol { padding-left: 1.6em; }
  .v-print-content blockquote {
    border-left: 3px solid #ccc; margin-left: 0; padding-left: 12px; color: #444;
  }
  .v-print-content pre {
    background: #f5f5f7; border: 1px solid #e2e2e6; border-radius: 4px;
    padding: 8px 12px; font-family: Consolas, "Courier New", monospace;
    font-size: 0.9em; white-space: pre-wrap; word-wrap: break-word;
  }
  .v-print-content code { font-family: Consolas, "Courier New", monospace; font-size: 0.9em; }
  .v-print-content img { max-width: 100%; height: auto; }
  .v-print-content div[data-type="mermaid"] { margin: 0.6em 0; text-align: center; }
  .v-print-content div[data-type="mermaid"] svg { max-width: 100%; height: auto; }
  .v-print-content table { border-collapse: collapse; }
  .v-print-content th, .v-print-content td {
    border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top;
  }
  .v-print-content a { color: #0645ad; }
  .v-print-content img, .v-print-content table,
  .v-print-content pre, .v-print-content blockquote {
    break-inside: avoid; page-break-inside: avoid;
  }
`;

/** Wait until every image in the doc has loaded (or errored), capped so a slow/
 * missing asset can't hang the print. */
function waitForImages(doc: Document): Promise<void> {
  const imgs = Array.from(doc.images);
  if (imgs.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = imgs.length;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const one = () => {
      pending -= 1;
      if (pending <= 0) finish();
    };
    setTimeout(finish, 3000);
    for (const img of imgs) {
      if (img.complete) one();
      else {
        img.addEventListener("load", one, { once: true });
        img.addEventListener("error", one, { once: true });
      }
    }
  });
}

/** Render an HTML document into a hidden iframe and invoke its print dialog. */
function printHtmlInIframe(docHtml: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    Object.assign(iframe.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "0",
      height: "0",
      border: "0",
      visibility: "hidden",
    });
    document.body.appendChild(iframe);

    const idoc = iframe.contentDocument;
    if (!idoc) {
      iframe.remove();
      resolve();
      return;
    }

    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      const win = iframe.contentWindow;
      if (!win) {
        iframe.remove();
        resolve();
        return;
      }
      void waitForImages(idoc).then(() => {
        win.focus();
        win.print();
        // Keep the iframe alive briefly so the print dialog has the document.
        setTimeout(() => iframe.remove(), 1000);
        resolve();
      });
    };

    iframe.onload = run;
    idoc.open();
    idoc.write(docHtml);
    idoc.close();
    // document.write often doesn't fire onload — kick it once the doc is parsed.
    setTimeout(() => {
      if (idoc.readyState === "complete") run();
    }, 50);
  });
}

/**
 * Print the open page. Pulls the editor's HTML, resolves inline image paths to
 * loadable asset URLs, appends an attachment filename list, and prints it in
 * isolation. Surfaces failures via `onError`.
 */
export async function printCurrentPage(opts: {
  editor: Editor;
  notebookId: string;
  pageId: string;
  title: string;
  onError?: (message: string) => void;
}): Promise<void> {
  const { editor, notebookId, pageId, title, onError } = opts;
  try {
    // getHTML() emits raw notebook-relative image srcs; resolve them the same way
    // the editor's NodeView does, so they load inside the iframe.
    let base = "";
    try {
      const dir = await api.notebookPath(notebookId);
      base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    } catch {
      /* external images still print; a missing local one just won't render */
    }

    const parsed = new DOMParser().parseFromString(editor.getHTML(), "text/html");
    parsed.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (base && src && !/^(https?:|data:|asset:|blob:|file:|http:\/\/asset)/i.test(src)) {
        img.setAttribute("src", convertFileSrc(`${base}/${src.replace(/^\/+/, "")}`));
      }
    });
    // getHTML() emits each Mermaid diagram as its raw source; render it to SVG so
    // the printed page shows the diagram, not the source text.
    for (const el of Array.from(parsed.querySelectorAll('div[data-type="mermaid"]'))) {
      const src = (el.getAttribute("data-source") ?? el.textContent ?? "").trim();
      if (!src) continue;
      try {
        el.innerHTML = await renderMermaid(src);
      } catch {
        /* leave the source text as a fallback */
      }
    }
    const contentHtml = parsed.body.innerHTML;

    const attachments = await api.listAttachments(notebookId, pageId).catch(() => []);
    const attachmentsHtml = attachments.length
      ? `<ul class="v-print-attachments">${attachments
          .map((a) => `<li>${escapeHtml(a.filename)}</li>`)
          .join("")}</ul>`
      : "";

    const heading = escapeHtml(title.trim() || "Untitled");
    const docHtml =
      `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>` +
      `<style>${PRINT_CSS}</style></head><body>` +
      `<h1 class="v-print-title">${heading}</h1>` +
      attachmentsHtml +
      `<div class="v-print-content">${contentHtml}</div>` +
      `</body></html>`;

    await printHtmlInIframe(docHtml);
  } catch (e) {
    onError?.(typeof e === "string" ? e : `Print failed: ${String(e)}`);
  }
}
