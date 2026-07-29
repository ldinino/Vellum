/**
 * Renders Harper grammar lints as ProseMirror decorations (spec Section 10).
 *
 * Decorations — not a stored mark — because grammar errors are transient: they
 * must never persist into the saved document or the search index, and they
 * update as the user edits. The set is mapped through each transaction so
 * underlines track edits between re-checks, and each decoration carries its lint
 * data so hover/accept/ignore can look it up at the live position.
 */

import { Extension } from "@tiptap/core";
import { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { MappedLint } from "./grammar";

export const grammarKey = new PluginKey<DecorationSet>("grammarError");

/**
 * Remove underlines that now sit on code — an inline `code` mark or text inside
 * a `codeBlock`. Code is never proofed (`extractText` omits it), so when the
 * user turns already-underlined text into code the lint must disappear at once
 * rather than linger until Harper next runs.
 */
function dropDecorationsOnCode(set: DecorationSet, doc: PMNode): DecorationSet {
  if (set === DecorationSet.empty) return set;
  const codeType = doc.type.schema.marks.code;
  const onCode = set.find().filter((deco) => {
    const { from, to } = deco as Decoration & { from: number; to: number };
    const $from = doc.resolve(from);
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === "codeBlock") return true;
    }
    return codeType ? doc.rangeHasMark(from, to, codeType) : false;
  });
  return onCode.length ? set.remove(onCode) : set;
}

export interface GrammarHit {
  from: number;
  to: number;
  message: string;
  kind: string;
  /** Misspelling vs grammar lint — selects the underline + context menu. */
  isSpelling: boolean;
  suggestions: string[];
  instanceKey: string;
}

export const GrammarError = Extension.create({
  name: "grammarError",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: grammarKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(grammarKey) as MappedLint[] | undefined;
            if (meta) {
              const decos = meta.map((m) =>
                Decoration.inline(
                  m.from,
                  m.to,
                  { class: m.isSpelling ? "v-spell-error" : "v-grammar-error" },
                  {
                    message: m.message,
                    kind: m.kind,
                    isSpelling: m.isSpelling,
                    suggestions: m.suggestions,
                    instanceKey: m.instanceKey,
                  },
                ),
              );
              return DecorationSet.create(tr.doc, decos);
            }
            // No new lints this tx: map existing underlines through the edit,
            // then drop any that the edit pushed onto code (inline `code` or a
            // `codeBlock`) so a lint never lingers on code between re-checks.
            const mapped = value.map(tr.mapping, tr.doc);
            return tr.docChanged ? dropDecorationsOnCode(mapped, tr.doc) : mapped;
          },
        },
        props: {
          decorations(state) {
            return grammarKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** Replace the displayed lints (mapped, filtered) with a new set. */
export function setGrammarLints(editor: Editor, lints: MappedLint[]) {
  const { view } = editor;
  view.dispatch(view.state.tr.setMeta(grammarKey, lints));
}

/** Clear all grammar underlines. */
export function clearGrammarLints(editor: Editor) {
  setGrammarLints(editor, []);
}

/**
 * Human-readable label for a Harper suggestion button/menu item. Harper often
 * suggests a deletion (empty string) or a pure-whitespace replacement (e.g. a
 * single space to collapse a double space); both render as a blank, near-
 * unclickable sliver, so describe them in words instead of showing the raw
 * value. Suggestions with visible text are shown as-is.
 */
export function suggestionLabel(s: string): string {
  if (s === "") return "Remove";
  if (s.trim() === "") return s === " " ? "Single space" : "Fix spacing";
  return s;
}

/** The lint at a document position (live coords), or null. */
export function grammarHitAt(editor: Editor, pos: number): GrammarHit | null {
  const decoSet = grammarKey.getState(editor.state);
  if (!decoSet) return null;
  const found = decoSet.find(pos, pos);
  if (found.length === 0) return null;
  // `from`/`to` are public on a Decoration and reflect the live (post-edit) span.
  const d = found[0] as Decoration & { from: number; to: number };
  const spec = d.spec as Omit<GrammarHit, "from" | "to">;
  return {
    from: d.from,
    to: d.to,
    message: spec.message,
    kind: spec.kind,
    isSpelling: spec.isSpelling,
    suggestions: spec.suggestions,
    instanceKey: spec.instanceKey,
  };
}
