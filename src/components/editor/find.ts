/**
 * In-page find (Ctrl+F) for the open editor. A self-contained ProseMirror plugin
 * kept separate from SearchHighlight (the global-search highlight) so the two
 * never fight over decorations: this one highlights every match, emphasises the
 * current one, and exposes the match count/index so the FindBar can drive
 * next/previous and show "3 / 12". Case-insensitive (like a browser's find).
 */

import { Extension } from "@tiptap/core";
import { Editor } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const findKey = new PluginKey<FindState>("find");

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  matches: Match[];
  /** Index into `matches`; -1 when there are none. */
  current: number;
  deco: DecorationSet;
}

const EMPTY: FindState = {
  query: "",
  matches: [],
  current: -1,
  deco: DecorationSet.empty,
};

/** Every case-insensitive occurrence of `query` across the doc's text nodes. */
function findMatches(doc: PMNode, query: string): Match[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = node.text.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      const from = pos + idx;
      out.push({ from, to: from + needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
  });
  return out;
}

function build(doc: PMNode, query: string, want: number): FindState {
  const matches = findMatches(doc, query);
  const current = matches.length === 0 ? -1 : Math.max(0, Math.min(want, matches.length - 1));
  const deco = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === current ? "v-find-hit v-find-hit--current" : "v-find-hit",
      }),
    ),
  );
  return { query, matches, current, deco };
}

export const Find = Extension.create({
  name: "find",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(findKey) as
              | { query?: string; current?: number }
              | undefined;
            if (meta) {
              const query = meta.query !== undefined ? meta.query : value.query;
              const current = meta.current !== undefined ? meta.current : value.current;
              return build(newState.doc, query, current);
            }
            // Keep matches accurate across edits while the bar is open.
            if (tr.docChanged && value.query) {
              return build(newState.doc, value.query, value.current);
            }
            return value;
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.deco ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export interface FindStats {
  count: number;
  current: number;
}

function readStats(editor: Editor): FindStats {
  const s = findKey.getState(editor.state);
  return { count: s?.matches.length ?? 0, current: s?.current ?? -1 };
}

/** Select + scroll the current match into view without stealing DOM focus. */
function revealCurrent(editor: Editor) {
  const s = findKey.getState(editor.state);
  if (!s || s.current < 0) return;
  const m = s.matches[s.current];
  const { view } = editor;
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to));
  view.dispatch(tr.scrollIntoView());
}

/** Set the query (jumping to the first match) and reveal it. */
export function setFindQuery(editor: Editor, query: string): FindStats {
  editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { query, current: 0 }));
  revealCurrent(editor);
  return readStats(editor);
}

export function findNext(editor: Editor): FindStats {
  const s = findKey.getState(editor.state);
  if (s && s.matches.length > 0) {
    const current = (s.current + 1) % s.matches.length;
    editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { current }));
    revealCurrent(editor);
  }
  return readStats(editor);
}

export function findPrev(editor: Editor): FindStats {
  const s = findKey.getState(editor.state);
  if (s && s.matches.length > 0) {
    const current = (s.current - 1 + s.matches.length) % s.matches.length;
    editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { current }));
    revealCurrent(editor);
  }
  return readStats(editor);
}

/** Drop all find highlights (called when the bar closes or the page swaps out). */
export function clearFind(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { query: "", current: -1 }));
}

/** Window event the menus dispatch to ask the shell to open the find box. */
export const OPEN_FIND_EVENT = "vellum:open-find";

/** Open the in-page find box from anywhere (Edit menu, editor context menu). */
export function requestOpenFind() {
  window.dispatchEvent(new Event(OPEN_FIND_EVENT));
}
