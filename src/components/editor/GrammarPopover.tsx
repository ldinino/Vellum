/**
 * Hover tooltip for grammar/spelling underlines (spec Section 10): hovering an
 * underline shows the rule/message and clickable suggestions ("Click suggestion
 * to accept"). Right-click (Accept / Ignore / Ignore Rule) is handled by the
 * unified [EditorContextMenu] so the editor has a single right-click path.
 */

import { useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/react";
import { grammarHitAt, GrammarHit } from "./GrammarError";
import "./GrammarPopover.css";

interface Anchored {
  hit: GrammarHit;
  x: number;
  y: number;
}

export function GrammarPopover({
  editor,
  onAfterAction,
}: {
  editor: Editor | null;
  onAfterAction: () => void;
}) {
  const [tooltip, setTooltip] = useState<Anchored | null>(null);
  const hideTimer = useRef<number | null>(null);

  const cancelHide = () => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setTooltip(null), 250);
  };

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;

    const onMove = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.(".v-grammar-error, .v-spell-error");
      if (!el) {
        scheduleHide();
        return;
      }
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      const hit = at ? grammarHitAt(editor, at.pos) : null;
      if (!hit) {
        scheduleHide();
        return;
      }
      cancelHide();
      const rect = (el as HTMLElement).getBoundingClientRect();
      setTooltip({ hit, x: rect.left, y: rect.bottom + 4 });
    };

    dom.addEventListener("mousemove", onMove);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      cancelHide();
    };
  }, [editor]);

  if (!editor) return null;

  const accept = (hit: GrammarHit, suggestion: string) => {
    const chain = editor.chain().focus();
    if (suggestion === "") chain.deleteRange({ from: hit.from, to: hit.to }).run();
    else chain.insertContentAt({ from: hit.from, to: hit.to }, suggestion).run();
    setTooltip(null);
    onAfterAction();
  };

  const suggestionLabel = (s: string) => (s === "" ? "Remove" : s);

  return (
    <>
      {tooltip && (
        <div
          className="v-grammar-tip"
          style={{ left: tooltip.x, top: tooltip.y }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          role="tooltip"
        >
          <div className="v-grammar-tip__msg">{tooltip.hit.message}</div>
          <div className="v-grammar-tip__rule">{tooltip.hit.kind}</div>
          {tooltip.hit.suggestions.length > 0 && (
            <div className="v-grammar-tip__suggestions">
              {tooltip.hit.suggestions.slice(0, 5).map((s, i) => (
                <button
                  key={i}
                  type="button"
                  className="v-grammar-tip__suggestion"
                  onClick={() => accept(tooltip.hit, s)}
                >
                  {suggestionLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
