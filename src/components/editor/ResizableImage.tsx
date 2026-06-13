/**
 * Image node with drag-to-resize handles, built on @tiptap/extension-image.
 * Adds a `width` attribute and a React NodeView. The stored `src` is a
 * notebook-relative path (portable across machines / OneDrive); a resolver,
 * set by the editor for the current notebook, turns it into a webview-loadable
 * URL at render time (Tauri asset protocol). Default resolver is identity so
 * plain URLs still work.
 */

import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from "@tiptap/react";

let resolveSrc: (src: string) => string = (src) => src;
export function setImageSrcResolver(fn: (src: string) => string) {
  resolveSrc = fn;
}

function ImageNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { src, alt, title, width } = node.attrs as {
    src: string;
    alt?: string;
    title?: string;
    width?: number | null;
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const img = (e.currentTarget as HTMLElement)
      .closest(".v-img-wrap")
      ?.querySelector("img");
    const startWidth = img?.getBoundingClientRect().width ?? 0;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(40, Math.round(startWidth + (ev.clientX - startX)));
      updateAttributes({ width: next });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <NodeViewWrapper
      className={`v-img-wrap ${selected ? "v-img-wrap--selected" : ""}`}
      data-drag-handle
    >
      <img
        src={resolveSrc(src)}
        alt={alt ?? ""}
        title={title ?? undefined}
        style={width ? { width: `${width}px` } : undefined}
        draggable={false}
      />
      {editor.isEditable && (
        <span
          className="v-img-handle"
          onMouseDown={startResize}
          aria-hidden="true"
        />
      )}
    </NodeViewWrapper>
  );
}

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = el.getAttribute("width") || (el as HTMLElement).style.width;
          if (!w) return null;
          const n = parseInt(w, 10);
          return Number.isNaN(n) ? null : n;
        },
        renderHTML: (attrs) =>
          attrs.width ? { width: attrs.width, style: `width: ${attrs.width}px` } : {},
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
