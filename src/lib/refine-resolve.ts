/**
 * Accept / reject / revert for Refine suggestions (spec Section 9, Phase 8).
 *
 *   insert  → accept keeps the new text · reject deletes it
 *   delete  → accept deletes the text   · reject keeps it
 *   rewrite → accept keeps the result   · reject (Revert) restores the original
 *
 * Group operations apply right-to-left so earlier positions stay valid while
 * later runs are deleted in the same transaction.
 */

import { Editor } from "@tiptap/react";
import { refineRuns, RefineRun } from "../components/editor/RefineSuggestion";

function markType(editor: Editor) {
  return editor.schema.marks.refineSuggestion;
}

/** Accept one suggestion run. */
export function acceptRun(editor: Editor, run: RefineRun) {
  const tr = editor.state.tr;
  if (run.type === "delete") tr.delete(run.from, run.to);
  else tr.removeMark(run.from, run.to, markType(editor));
  editor.view.dispatch(tr);
}

/** Reject one suggestion run (rewrite → Revert). */
export function rejectRun(editor: Editor, run: RefineRun) {
  if (run.type === "rewrite") {
    revertRewrite(editor, run.group);
    return;
  }
  const tr = editor.state.tr;
  if (run.type === "insert") tr.delete(run.from, run.to);
  else tr.removeMark(run.from, run.to, markType(editor));
  editor.view.dispatch(tr);
}

/** Accept every suggestion in a group. */
export function acceptGroup(editor: Editor, group: string) {
  const runs = refineRuns(editor, (r) => r.group === group);
  if (runs.some((r) => r.type === "rewrite")) {
    // Accept a rewrite: just drop the marks, keep the produced text.
    const tr = editor.state.tr;
    for (const run of [...runs].sort((a, b) => b.from - a.from)) {
      tr.removeMark(run.from, run.to, markType(editor));
    }
    editor.view.dispatch(tr);
    return;
  }
  applyRuns(editor, runs, "accept");
}

/** Reject every suggestion in a group (rewrite → Revert). */
export function rejectGroup(editor: Editor, group: string) {
  const runs = refineRuns(editor, (r) => r.group === group);
  if (runs.some((r) => r.type === "rewrite")) {
    revertRewrite(editor, group);
    return;
  }
  applyRuns(editor, runs, "reject");
}

function applyRuns(editor: Editor, runs: RefineRun[], action: "accept" | "reject") {
  const tr = editor.state.tr;
  const mt = markType(editor);
  for (const run of [...runs].sort((a, b) => b.from - a.from)) {
    const remove = action === "accept" ? run.type === "delete" : run.type === "insert";
    if (remove) tr.delete(run.from, run.to);
    else tr.removeMark(run.from, run.to, mt);
  }
  editor.view.dispatch(tr);
}

/** Restore the original text a rewrite replaced. Handles both the inline case
 * (rewrite kept within one block) and the structural case (rewrite spanned
 * several top-level blocks → collapse them back to one paragraph). */
export function revertRewrite(editor: Editor, group: string) {
  const runs = refineRuns(editor, (r) => r.group === group && r.type === "rewrite");
  if (!runs.length) return;

  const from = Math.min(...runs.map((r) => r.from));
  const to = Math.max(...runs.map((r) => r.to));
  const original = runs.find((r) => r.original != null)?.original ?? "";

  const { doc, tr } = editor.state;
  const schema = editor.schema;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);

  if ($from.sameParent($to)) {
    if (original) tr.replaceWith(from, to, schema.text(original));
    else tr.delete(from, to);
  } else {
    const blockStart = $from.before(1);
    const blockEnd = $to.after(1);
    const para = schema.nodes.paragraph.create(
      null,
      original ? schema.text(original) : undefined,
    );
    tr.replaceWith(blockStart, blockEnd, para);
  }
  editor.view.dispatch(tr);
}
