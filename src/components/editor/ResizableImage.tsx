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
import type { Attributes } from "@tiptap/react";

let resolveSrc: (src: string) => string = (src) => src;
export function setImageSrcResolver(fn: (src: string) => string) {
  resolveSrc = fn;
}

/** Turn a stored (notebook-relative) image src into a webview-loadable URL. */
export function resolveImageSrc(src: string): string {
  return resolveSrc(src);
}

/** Attribute the clipboard helper stamps on a copied `<img>` so the original
 * notebook-relative path survives alongside the `data:` URI that external apps
 * need (see src/lib/clipboard.ts). */
export const VELLUM_SRC_ATTR = "data-vellum-src";

/** Shape of an inline-image path we're willing to restore from a pasted
 * `data-vellum-src`: exactly `attachments/<page-id>/<file>`, no traversal. */
const STORED_SRC = /^attachments\/[^/\\]+\/[^/\\]+$/;

/** The pasted marker's value if it is a path we stored ourselves, else null —
 * the HTML could come from anywhere, so an arbitrary path is never trusted. */
function storedSrc(value: string | null): string | null {
  const norm = value?.replace(/\\/g, "/") ?? "";
  return STORED_SRC.test(norm) && !norm.split("/").includes("..") ? norm : null;
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
  // Our own copies carry a `data:` URI in `src` (so other apps can render them)
  // and the stored path in `data-vellum-src`. The base rule ignores data URIs,
  // so match those images explicitly and read the path back off the marker.
  parseHTML() {
    return [{ tag: `img[${VELLUM_SRC_ATTR}]` }, ...(this.parent?.() ?? [])];
  },
  addAttributes() {
    const parent: Attributes = this.parent?.() ?? {};
    return {
      ...parent,
      src: {
        ...parent.src,
        parseHTML: (el: HTMLElement) =>
          storedSrc(el.getAttribute(VELLUM_SRC_ATTR)) ?? el.getAttribute("src"),
      },
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
