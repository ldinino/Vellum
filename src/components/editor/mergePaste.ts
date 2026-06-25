/**
 * Merge-formatting paste (UX polish).
 *
 * ProseMirror inserts a pasted slice with whatever marks the clipboard carried;
 * plain text arrives with none, so it renders at the editor's CSS default
 * (Segoe UI 14 — styles/tokens.css) no matter where the caret sits. That makes
 * a paste feel foreign: it ignores the formatting of the text it lands in.
 *
 * This rewrites the `textStyle` mark — which holds fontFamily/fontSize/color
 * (spec Section 6) — on every pasted text node so the paste merges into its
 * destination: the clipboard's font/size/color are dropped and re-stamped with
 * whatever is active at the caret. Emphasis and structure marks (bold, italic,
 * underline, links, highlight, …) are preserved untouched. Headings, code
 * blocks, and inline code keep their intrinsic look (size/monospace come from
 * CSS, not a mark), so there we only strip the foreign style and never paint a
 * body font over them.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Mark, MarkType, Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

const STYLE_MARK = "textStyle";

// Blocks whose font/size is intrinsic (CSS-driven). Inside them we clear the
// clipboard's textStyle but never re-stamp the caret's body style, so a pasted
// heading or code block keeps its own look instead of shrinking to body size.
const INTRINSIC_FONT_BLOCKS = new Set(["heading", "codeBlock"]);

function restyle(
  fragment: Fragment,
  destStyle: Mark | null,
  styleType: MarkType,
  intrinsic: boolean,
): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    if (child.isText) {
      const marks = child.marks.filter((m) => m.type !== styleType);
      const isCode = child.marks.some((m) => m.type.name === "code");
      const reStamp = destStyle && !intrinsic && !isCode;
      out.push(child.mark(reStamp ? destStyle.addToSet(marks) : marks));
    } else {
      const childIntrinsic = intrinsic || INTRINSIC_FONT_BLOCKS.has(child.type.name);
      out.push(child.copy(restyle(child.content, destStyle, styleType, childIntrinsic)));
    }
  });
  return Fragment.fromArray(out);
}

function mergePastedFormatting(slice: Slice, view: EditorView): Slice {
  const { $from } = view.state.selection;
  // Pasting into a code block: it's monospace by definition (and arrives as a
  // bare text node with no parent context here), so leave the paste untouched.
  if ($from.parent.type.spec.code) return slice;
  const styleType = view.state.schema.marks[STYLE_MARK];
  if (!styleType) return slice;
  // The marks a typed character would inherit here — what we conform the paste to.
  const active = view.state.storedMarks ?? $from.marks();
  const destStyle = active.find((m) => m.type === styleType) ?? null;
  return new Slice(
    restyle(slice.content, destStyle, styleType, false),
    slice.openStart,
    slice.openEnd,
  );
}

/**
 * Conforms pasted text to the caret's formatting (see file header). Registered
 * in buildExtensions so every editor — the page editor and the template editor
 * — pastes the same way.
 */
export const MergePaste = Extension.create({
  name: "mergePaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mergePaste"),
        props: {
          transformPasted: (slice, view) => mergePastedFormatting(slice, view),
        },
      }),
    ];
  },
});
