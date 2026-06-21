/**
 * Render a Refine model's output (which may be Markdown — a template can ask for
 * headings, bold, lists, tables) into HTML that Tiptap parses through the editor
 * schema (spec Section 8, Phase 8). `html: false` so any raw HTML the model emits
 * is escaped to text, not injected — belt-and-suspenders with Tiptap's own
 * schema sanitisation (the model output is untrusted).
 */

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** Render model output to HTML for insertion into the editor. */
export function renderMarkdown(src: string): string {
  return md.render(src);
}

/** Plain-text projection of rendered Markdown — used for the word-level diff and
 * the change-ratio decision. */
export function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").trim();
}

/**
 * Does the rendered output carry structure or inline formatting? If so it goes
 * through the rewrite path (parsed rich content preserved), keeping the
 * word-level inline-diff path to truly plain single-paragraph edits.
 */
export function isStructural(html: string): boolean {
  const div = document.createElement("div");
  div.innerHTML = html;
  if (
    div.querySelector(
      "h1,h2,h3,h4,h5,h6,ul,ol,li,table,pre,blockquote,hr,strong,b,em,i,code,a,s,del,mark,sub,sup",
    )
  ) {
    return true;
  }
  // More than one block (e.g. the model split it into paragraphs).
  return div.querySelectorAll("p").length > 1;
}
