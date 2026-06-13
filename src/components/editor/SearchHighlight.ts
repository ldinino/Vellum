/**
 * Highlights search terms in the open page and scrolls the first match into
 * view (spec Section 11: "open page, scroll to first match, highlight matches").
 *
 * Terms are pushed in via `applySearchHighlight` rather than configured at
 * build time, so the same editor instance can re-highlight when the user runs a
 * new search without remounting. Decorations rebuild on every doc change so they
 * survive edits.
 */

import { Extension } from "@tiptap/core";
import { Editor } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const searchHighlightKey = new PluginKey<HighlightState>("searchHighlight");

interface HighlightState {
  terms: string[];
  deco: DecorationSet;
}

function buildDecorations(doc: PMNode, terms: string[]): DecorationSet {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (needles.length === 0) return DecorationSet.empty;

  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLowerCase();
    for (const needle of needles) {
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        const from = pos + idx;
        decos.push(Decoration.inline(from, from + needle.length, { class: "v-search-hit" }));
        idx = haystack.indexOf(needle, idx + needle.length);
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: searchHighlightKey,
        state: {
          init: () => ({ terms: [], deco: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(searchHighlightKey) as { terms: string[] } | undefined;
            const terms = meta ? meta.terms : value.terms;
            if (meta || tr.docChanged) {
              return { terms, deco: buildDecorations(newState.doc, terms) };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return searchHighlightKey.getState(state)?.deco ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/** Set (or clear, with `[]`) the highlighted terms and scroll to the first match. */
export function applySearchHighlight(editor: Editor, terms: string[]) {
  const { view } = editor;
  view.dispatch(view.state.tr.setMeta(searchHighlightKey, { terms }));

  if (terms.length === 0) return;
  const deco = searchHighlightKey.getState(view.state)?.deco;
  const first = deco?.find()?.[0];
  if (first) {
    const sel = TextSelection.create(view.state.doc, first.from);
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  }
}
