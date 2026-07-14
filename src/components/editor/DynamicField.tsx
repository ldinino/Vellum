/**
 * Live template field node (execution-plan #7).
 *
 * An inline atom that displays a date/time value recomputed every time the node
 * mounts — i.e. every page load — so a field inserted into a template keeps
 * showing "now" in every page created from it (like a Word date field, not a
 * ticking clock). Contrast with the one-shot `{{Token}}` placeholders, which the
 * backend stamps once at page-creation time and are plain text forever after.
 *
 * The value/format logic lives in lib/dynamic-fields.ts (no React/Tiptap) so the
 * Markdown exporter can share it. `renderHTML` emits the *computed* value as the
 * element's text (`<span data-type="dynamic-field" …>July 14, 2026</span>`), so
 * `getHTML()`-based consumers — Markdown export and print — capture the current
 * value with no special handling; the data attributes let the node parse back in.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { formatDynamicField, type DynamicFieldKind } from "../../lib/dynamic-fields";

function DynamicFieldNodeView({ node, selected }: NodeViewProps) {
  const kind = (node.attrs.kind as DynamicFieldKind) ?? "date";
  const format = (node.attrs.format as string | null) ?? null;
  // Computed on mount (and any re-render): "live" means re-evaluated whenever the
  // page loads, so reading the current time here is exactly the intended behavior.
  const text = formatDynamicField(kind, format);
  return (
    <NodeViewWrapper
      as="span"
      className={"v-dynfield" + (selected ? " v-dynfield--selected" : "")}
      contentEditable={false}
    >
      {text}
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dynamicField: {
      /** Insert a live date/time field (execution-plan #7). */
      insertDynamicField: (kind: DynamicFieldKind, format?: string | null) => ReturnType;
    };
  }
}

export const DynamicField = Node.create({
  name: "dynamicField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: {
        default: "date",
        parseHTML: (el) => el.getAttribute("data-kind") ?? "date",
        renderHTML: (attrs) => ({ "data-kind": attrs.kind }),
      },
      format: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-format"),
        renderHTML: (attrs) =>
          attrs.format ? { "data-format": attrs.format } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="dynamic-field"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = (node.attrs.kind as DynamicFieldKind) ?? "date";
    const format = (node.attrs.format as string | null) ?? undefined;
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": "dynamic-field", class: "v-dynfield" }),
      formatDynamicField(kind, format),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DynamicFieldNodeView);
  },

  addCommands() {
    return {
      insertDynamicField:
        (kind, format) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { kind, format: format ?? null },
          }),
    };
  },
});
