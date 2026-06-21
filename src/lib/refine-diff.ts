/**
 * Word-level diff + apply for Refine (spec Section 9, Phase 8).
 *
 * The backend returns transformed text (possibly Markdown). We decide how to
 * render it against the original selection:
 *   - **inline** — a small, plain, single-paragraph edit: word-level
 *     insert/delete suggestions the user accepts/rejects piece by piece.
 *   - **rewrite** — a large change (>40%) or any structural/inline formatting:
 *     the parsed rich content replaces the selection as one block with a Revert,
 *     preserving the formatting the template produced.
 *
 * Diffing is on word tokens (whitespace preserved) via diff-match-patch's
 * char-encoding trick, so boundaries land on words, not letters.
 */

import { diff_match_patch } from "diff-match-patch";
import { Editor } from "@tiptap/react";
import { renderMarkdown, htmlToPlainText, isStructural } from "./refine-markdown";

/** diff-match-patch op codes: -1 delete, 0 equal, 1 insert. */
export interface WordOp {
  op: -1 | 0 | 1;
  text: string;
}

export interface RefinePlan {
  mode: "inline" | "rewrite";
  group: string;
  /** Pre-Refine selection text, stored for Revert. */
  original: string;
  /** inline mode. */
  diffs?: WordOp[];
  /** rewrite mode, structural: rich HTML to parse into the doc. */
  html?: string;
  /** rewrite mode, plain: large plain-text rewrite kept inline. */
  plainText?: string;
  structural?: boolean;
}

/** Change ratio above which an edit reads as a rewrite rather than tweaks. */
const REWRITE_THRESHOLD = 0.4;

function tokenize(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** Word-level diff: encode each unique token as a char, diff, then decode. */
export function wordDiff(a: string, b: string): WordOp[] {
  const dmp = new diff_match_patch();
  const dict = new Map<string, number>();
  const list: string[] = [];
  const encode = (toks: string[]) =>
    toks
      .map((t) => {
        let idx = dict.get(t);
        if (idx === undefined) {
          idx = list.length;
          dict.set(t, idx);
          list.push(t);
        }
        return String.fromCharCode(idx);
      })
      .join("");
  const ea = encode(tokenize(a));
  const eb = encode(tokenize(b));
  const diffs = dmp.diff_main(ea, eb, false);
  return diffs.map(([op, chars]) => ({
    op: op as -1 | 0 | 1,
    text: Array.from(chars)
      .map((ch) => list[ch.charCodeAt(0)])
      .join(""),
  }));
}

function changeRatio(diffs: WordOp[], aLen: number, bLen: number): number {
  let changed = 0;
  for (const d of diffs) if (d.op !== 0) changed += d.text.length;
  return changed / Math.max(1, aLen + bLen);
}

/** Decide how to render a Refine result against the original selection. */
export function planRefine(original: string, refined: string): RefinePlan {
  const group =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `refine-${Date.now()}-${Math.random()}`;
  const html = renderMarkdown(refined);
  const plain = htmlToPlainText(html);

  if (isStructural(html)) {
    return { mode: "rewrite", group, original, html, structural: true };
  }

  const diffs = wordDiff(original, plain);
  if (changeRatio(diffs, original.length, plain.length) > REWRITE_THRESHOLD) {
    return { mode: "rewrite", group, original, plainText: plain, structural: false };
  }
  return { mode: "inline", group, original, diffs };
}

/** Whether the plan actually changes anything (else: "Refine made no changes"). */
export function planHasChanges(plan: RefinePlan): boolean {
  if (plan.mode === "rewrite") {
    const next = (plan.html ? htmlToPlainText(plan.html) : plan.plainText ?? "").trim();
    return next.length > 0 && next !== plan.original.trim();
  }
  return (plan.diffs ?? []).some((d) => d.op !== 0 && d.text.trim().length > 0);
}

/**
 * Replace the selection [from,to] with the accepted Refine result (no review
 * marks — the user already approved it in the preview modal). Structural Markdown
 * becomes rich blocks; plain output stays inline within the block.
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

/** Replace the selection [from,to] with the planned suggestions/marks. */
export function applyRefine(editor: Editor, from: number, to: number, plan: RefinePlan) {
  const schema = editor.schema;
  const markType = schema.marks.refineSuggestion;

  if (plan.mode === "inline") {
    const nodes = [];
    for (const d of plan.diffs ?? []) {
      if (!d.text) continue;
      const marks =
        d.op === 0
          ? []
          : [
              markType.create({
                type: d.op === 1 ? "insert" : "delete",
                group: plan.group,
                original: null,
              }),
            ];
      nodes.push(schema.text(d.text, marks));
    }
    editor.view.dispatch(editor.state.tr.replaceWith(from, to, nodes));
    return;
  }

  // rewrite
  if (plan.structural && plan.html) {
    editor.chain().focus().insertContentAt({ from, to }, plan.html).run();
    const end = editor.state.selection.to;
    editor
      .chain()
      .setTextSelection({ from, to: end })
      .setMark("refineSuggestion", {
        type: "rewrite",
        group: plan.group,
        original: plan.original,
      })
      .setTextSelection(end)
      .run();
  } else {
    const text = plan.plainText ?? "";
    if (!text) {
      editor.view.dispatch(editor.state.tr.delete(from, to));
      return;
    }
    const node = schema.text(text, [
      markType.create({ type: "rewrite", group: plan.group, original: plan.original }),
    ]);
    editor.view.dispatch(editor.state.tr.replaceWith(from, to, node));
  }
}
