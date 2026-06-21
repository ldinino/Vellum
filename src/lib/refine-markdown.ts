/**
 * Render a Refine model's output (which may be Markdown — a template can ask for
 * headings, bold, lists, tables) into HTML that Tiptap parses through the editor
 * schema (spec Section 8, Phase 8), and insert the approved result into the page.
 * `html: false` so any raw HTML the model emits is escaped to text, not injected
 * — belt-and-suspenders with Tiptap's own schema sanitisation (model output is
 * untrusted).
 */

import { Editor } from "@tiptap/react";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** Render model output to HTML (used by the preview and by insertion). */
export function renderMarkdown(src: string): string {
  return md.render(src);
}

/** Plain-text projection of rendered Markdown. */
function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").trim();
}

/** Whether the rendered output carries block structure or inline formatting —
 * if so it's inserted as rich blocks, else as inline plain text. */
function isStructural(html: string): boolean {
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

/**
 * Replace the selection [from,to] with the approved Refine result (the user
 * accepted it in the preview dialog). Structural Markdown becomes rich blocks;
 * plain output stays inline within the block.
 */
export function insertRefinedText(editor: Editor, from: number, to: number, refined: string) {
  const html = renderMarkdown(refined);
  if (isStructural(html)) {
    editor.chain().focus().insertContentAt({ from, to }, html).run();
  } else {
    const plain = htmlToPlainText(html) || refined;
    editor.chain().focus().insertContentAt({ from, to }, plain).run();
  }
}
