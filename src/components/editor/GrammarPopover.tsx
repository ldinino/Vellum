/**
 * Hover tooltip + right-click menu for grammar underlines (spec Section 10):
 * hover shows the rule and clickable suggestions ("Click suggestion to accept");
 * right-click offers Accept / Ignore / Ignore Rule. All actions edit the doc and
 * then trigger a re-check so the underline refreshes immediately.
 */

import { useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/react";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { grammarHitAt, GrammarHit } from "./GrammarError";
import { ignoreInstance, ignoreRule } from "./grammar";
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
  const [menu, setMenu] = useState<Anchored | null>(null);
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
      const el = (e.target as HTMLElement)?.closest?.(".v-grammar-error");
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

    const onContext = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.(".v-grammar-error");
      if (!el) return;
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      const hit = at ? grammarHitAt(editor, at.pos) : null;
      if (!hit) return;
      e.preventDefault();
      setTooltip(null);
      setMenu({ hit, x: e.clientX, y: e.clientY });
    };

    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("contextmenu", onContext);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("contextmenu", onContext);
      cancelHide();
    };
  }, [editor]);

  if (!editor) return null;

  const accept = (hit: GrammarHit, suggestion: string) => {
    const chain = editor.chain().focus();
    if (suggestion === "") chain.deleteRange({ from: hit.from, to: hit.to }).run();
    else chain.insertContentAt({ from: hit.from, to: hit.to }, suggestion).run();
    setTooltip(null);
    setMenu(null);
    onAfterAction();
  };

  const ignoreThis = (hit: GrammarHit) => {
    ignoreInstance(hit.instanceKey);
    setTooltip(null);
    setMenu(null);
    onAfterAction();
  };

  const ignoreThisRule = (hit: GrammarHit) => {
    ignoreRule(hit.kind);
    setTooltip(null);
    setMenu(null);
    onAfterAction();
  };

  const suggestionLabel = (s: string) => (s === "" ? "Remove" : s);

  const menuItems = (hit: GrammarHit): MenuItem[] => [
    {
      label: hit.suggestions.length ? `Accept “${suggestionLabel(hit.suggestions[0])}”` : "No suggestion",
      icon: "tick",
      disabled: hit.suggestions.length === 0,
      onSelect: () => hit.suggestions.length && accept(hit, hit.suggestions[0]),
      separatorAfter: true,
    },
    { label: "Ignore", icon: "cross-small", onSelect: () => ignoreThis(hit) },
    { label: "Ignore Rule", icon: "eraser", onSelect: () => ignoreThisRule(hit) },
  ];

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

      {menu && (
        <ContextMenu
          items={menuItems(menu.hit)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
