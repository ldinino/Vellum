/**
 * The `refineSuggestion` mark + its review helpers (spec Section 9, Phase 8).
 *
 * Unlike grammar (transient decorations), Refine suggestions are real, tentative
 * edits to the document, so they're a stored Tiptap **mark** carrying:
 *   - `type`: "insert" | "delete" | "rewrite"
 *   - `group`: ties one Refine op's suggestions together (Accept All / Reject All)
 *   - `original`: the pre-Refine text, used to revert a rewrite
 *
 * A sibling ProseMirror plugin renders the in-flight "loading" underline over the
 * selection while the model runs.
 */

import { Mark, Extension, mergeAttributes } from "@tiptap/core";
import { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type RefineType = "insert" | "delete" | "rewrite";

export interface RefineRun {
  from: number;
  to: number;
  type: RefineType;
  group: string;
  original: string | null;
}

export const RefineSuggestion = Mark.create({
  name: "refineSuggestion",
  // Don't extend the mark when typing at its boundary — review markers shouldn't
  // grow as the user edits around them.
  inclusive: false,

  addAttributes() {
    return {
      type: {
        default: "insert" as RefineType,
        parseHTML: (el) => el.getAttribute("data-refine") || "insert",
        renderHTML: (attrs) => ({ "data-refine": attrs.type }),
      },
      group: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-refine-group") || "",
        renderHTML: (attrs) => (attrs.group ? { "data-refine-group": attrs.group } : {}),
      },
      original: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-refine-original"),
        renderHTML: (attrs) =>
          attrs.original != null ? { "data-refine-original": attrs.original } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-refine]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const type = (HTMLAttributes["data-refine"] as string) || "insert";
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: `v-refine v-refine--${type}` }),
      0,
    ];
  },
});

// ---- Review helpers --------------------------------------------------------

/** All contiguous refineSuggestion runs in the doc, optionally filtered. */
export function refineRuns(
  editor: Editor,
  predicate?: (run: RefineRun) => boolean,
): RefineRun[] {
  const markType = editor.schema.marks.refineSuggestion;
  if (!markType) return [];
  const runs: RefineRun[] = [];
  let cur: RefineRun | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) {
      if (cur) {
        runs.push(cur);
        cur = null;
      }
      return true;
    }
    const mark = node.marks.find((m) => m.type === markType);
    if (mark) {
      const from = pos;
      const to = pos + node.nodeSize;
      const attrs = mark.attrs as { type: RefineType; group: string; original: string | null };
      if (
        cur &&
        cur.to === from &&
        cur.type === attrs.type &&
        cur.group === attrs.group
      ) {
        cur.to = to;
      } else {
        if (cur) runs.push(cur);
        cur = { from, to, type: attrs.type, group: attrs.group, original: attrs.original };
      }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
    return true;
  });
  if (cur) runs.push(cur);

  return predicate ? runs.filter(predicate) : runs;
}

/** The suggestion run at a document position (live coords), or null. */
export function refineHitAt(editor: Editor, pos: number): RefineRun | null {
  return refineRuns(editor).find((r) => pos >= r.from && pos < r.to) ?? null;
}

/** Whether any unresolved suggestions remain (drives idle release + cleanup). */
export function hasRefineSuggestions(editor: Editor): boolean {
  return refineRuns(editor).length > 0;
}

// ---- In-flight loading underline ------------------------------------------

const loadingKey = new PluginKey<DecorationSet>("refineLoading");

/** ProseMirror plugin extension: a settable "loading" decoration range painted
 * over the selection while the model runs. */
export const RefineLoadingExtension = Extension.create({
  name: "refineLoading",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: loadingKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(loadingKey) as { from: number; to: number } | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: "v-refine-loading" }),
              ]);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return loadingKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** Show/hide the in-flight loading underline. Pass null to clear. */
export function setRefineLoading(editor: Editor, range: { from: number; to: number } | null) {
  const { view } = editor;
  view.dispatch(view.state.tr.setMeta(loadingKey, range));
}
