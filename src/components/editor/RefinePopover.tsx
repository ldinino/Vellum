/**
 * Hover tooltip for Refine suggestions (spec Section 9, Phase 8): hovering an
 * underlined suggestion offers Accept / Reject (Revert for a rewrite). The
 * fuller right-click menu (Accept All / Reject All) lives in [EditorContextMenu]
 * so the editor keeps a single right-click path — mirrors [GrammarPopover].
 */

import { useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/react";
import { refineHitAt, RefineRun } from "./RefineSuggestion";
import { acceptRun, rejectRun } from "../../lib/refine-resolve";
import "./RefinePopover.css";

interface Anchored {
  run: RefineRun;
  x: number;
  y: number;
}

export function RefinePopover({
  editor,
  onAfterAction,
}: {
  editor: Editor | null;
  onAfterAction: () => void;
}) {
  const [tip, setTip] = useState<Anchored | null>(null);
  const hideTimer = useRef<number | null>(null);

  const cancelHide = () => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setTip(null), 250);
  };

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;

    const onMove = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.(".v-refine");
      if (!el) {
        scheduleHide();
        return;
      }
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      const run = at ? refineHitAt(editor, at.pos) : null;
      if (!run) {
        scheduleHide();
        return;
      }
      cancelHide();
      const rect = (el as HTMLElement).getBoundingClientRect();
      setTip({ run, x: rect.left, y: rect.bottom + 4 });
    };

    dom.addEventListener("mousemove", onMove);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      cancelHide();
    };
  }, [editor]);

  if (!editor || !tip) return null;

  const after = () => {
    setTip(null);
    onAfterAction();
  };
  const accept = () => {
    acceptRun(editor, tip.run);
    after();
  };
  const reject = () => {
    rejectRun(editor, tip.run);
    after();
  };

  const rejectLabel = tip.run.type === "rewrite" ? "Revert" : "Reject";

  return (
    <div
      className="v-refine-tip"
      style={{ left: tip.x, top: tip.y }}
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
      role="tooltip"
    >
      <button type="button" className="v-refine-tip__btn v-refine-tip__btn--accept" onClick={accept}>
        Accept
      </button>
      <button type="button" className="v-refine-tip__btn" onClick={reject}>
        {rejectLabel}
      </button>
    </div>
  );
}
