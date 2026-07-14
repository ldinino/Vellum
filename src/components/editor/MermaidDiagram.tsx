/**
 * Mermaid diagram node (execution-plan #5).
 *
 * Stores the raw diagram source as a node attribute and renders it to inline SVG
 * with the `mermaid` package inside a React NodeView. The view has two modes:
 * the rendered diagram (with an "Edit" affordance / double-click) and a source
 * textarea. Invalid syntax is caught and shown as an explicit error state so a
 * bad diagram never crashes the editor.
 *
 * Serialization: `renderHTML` emits `<div data-type="mermaid" data-source="…">`
 * (the raw source, never the rendered SVG — `getHTML()` uses the schema, not the
 * NodeView). The source lives in the `data-source` attribute so its newlines
 * survive turndown's whitespace collapsing; it's also emitted as text content so
 * turndown doesn't drop the (otherwise empty) element as blank. That lets the
 * Markdown exporter turn it into a ```mermaid fenced block (see
 * lib/export-markdown.ts) and the print path re-render it to SVG (see
 * lib/print-page.ts). The same shape parses back into the node, so the document
 * round-trips through HTML.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

/** Starter diagram inserted by Insert ▸ Mermaid Diagram. */
export const DEFAULT_MERMAID_SOURCE = `graph TD
  A[Start] --> B{Is it clear?}
  B -->|Yes| C[Ship it]
  B -->|No| D[Refine]
  D --> B`;

let mermaidReady = false;
function ensureMermaidInit(): void {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    // The source is the user's own content, but "strict" also keeps a malformed
    // diagram from injecting anything unexpected into the rendered SVG.
    securityLevel: "strict",
    theme: "default",
    fontFamily: "inherit",
  });
  mermaidReady = true;
}

let renderSeq = 0;
/**
 * Render mermaid source to an SVG string. Rejects on invalid syntax. Shared by
 * the NodeView and the print path so both render diagrams identically.
 */
export async function renderMermaid(source: string): Promise<string> {
  ensureMermaidInit();
  const id = `v-mermaid-${(renderSeq += 1)}`;
  try {
    const { svg } = await mermaid.render(id, source.trim());
    return svg;
  } finally {
    // mermaid appends a temporary measuring element to <body>; on a parse error
    // it may not clean it up, leaving an orphan "error" diagram on the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" && e ? e : "Invalid diagram syntax";
}

function MermaidNodeView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const source = (node.attrs.source as string) ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-render whenever the committed source changes (not while editing the draft).
  useEffect(() => {
    let cancelled = false;
    const text = source.trim();
    if (!text) {
      setSvg("");
      setError(null);
      return;
    }
    renderMermaid(text).then(
      (out) => {
        if (!cancelled) {
          setSvg(out);
          setError(null);
        }
      },
      (e) => {
        if (!cancelled) {
          setSvg("");
          setError(errorText(e));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const beginEdit = () => {
    if (!editor.isEditable) return;
    setDraft(source);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft !== source) updateAttributes({ source: draft });
  };
  const cancel = () => {
    setEditing(false);
    setDraft(source);
  };

  return (
    <NodeViewWrapper
      className={
        "v-mermaid" +
        (selected ? " v-mermaid--selected" : "") +
        (editing ? " v-mermaid--editing" : "")
      }
    >
      {editing ? (
        <div className="v-mermaid__editor">
          <textarea
            ref={taRef}
            className="v-mermaid__source"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Keep ProseMirror from acting on keys typed into the source box
              // (Backspace deleting the node, Enter splitting blocks, shortcuts).
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
              }
            }}
            rows={Math.min(18, Math.max(4, draft.split("\n").length + 1))}
          />
          <div className="v-mermaid__actions">
            <button
              type="button"
              className="v-mermaid__btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="v-mermaid__btn v-mermaid__btn--primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commit}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div
          className="v-mermaid__view"
          data-drag-handle
          onDoubleClick={beginEdit}
        >
          {error ? (
            <div className="v-mermaid__error">
              <span className="v-mermaid__error-title">Diagram error</span>
              <span className="v-mermaid__error-msg">{error}</span>
              <pre className="v-mermaid__error-src">{source}</pre>
            </div>
          ) : svg ? (
            <div className="v-mermaid__svg" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="v-mermaid__empty">Empty diagram — double-click to edit</div>
          )}
          {editor.isEditable && (
            <button
              type="button"
              className="v-mermaid__edit"
              onMouseDown={(e) => e.preventDefault()}
              onClick={beginEdit}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mermaidDiagram: {
      /** Insert a Mermaid diagram node (defaults to the starter template). */
      insertMermaidDiagram: (source?: string) => ReturnType;
    };
  }
}

export const MermaidDiagram = Node.create({
  name: "mermaidDiagram",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      source: {
        default: DEFAULT_MERMAID_SOURCE,
        // Stored in a data attribute rather than the element's text content: the
        // Markdown exporter runs turndown, which collapses whitespace inside
        // non-<pre> elements and would flatten a multi-line diagram onto one
        // (often broken) line. Attribute values are left intact.
        parseHTML: (el) => el.getAttribute("data-source") ?? el.textContent ?? "",
        renderHTML: (attrs) => ({ "data-source": (attrs.source as string) ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mermaid"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Source of truth is the `data-source` attribute (exact, newline-safe). Also
    // emit it as text content so turndown doesn't treat the element as blank and
    // drop it before the export rule (which reads the attribute) can run.
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "mermaid" }),
      (node.attrs.source as string) ?? "",
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },

  addCommands() {
    return {
      insertMermaidDiagram:
        (source?: string) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { source: source ?? DEFAULT_MERMAID_SOURCE },
          }),
    };
  },
});
