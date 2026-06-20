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
