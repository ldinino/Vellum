/**
 * Colour dropdown for the toolbar's font-colour and highlight swatches.
 *
 * Modelled on WordPad/Office rather than a bare colour input: the common
 * colours are one click away in a grid, with the reset ("Automatic" / "No
 * highlight") pinned at the top and the OS precision picker one step further
 * down under "More colours…". The reset row shows a chip of the colour it will
 * actually produce, so in dark mode "Automatic" previews light ink rather than
 * a fixed black square.
 *
 * Dismissal and positioning mirror ContextMenu (mousedown outside, Escape,
 * window blur; clamped into the viewport; portaled to <body> so it paints above
 * the editor chrome).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/Icon";
import "./ColorMenu.css";

interface ColorMenuProps {
  /** Viewport position of the top-left corner; clamped on overflow. */
  x: number;
  y: number;
  /** Currently applied colour, so its swatch can be ticked. Null when unset. */
  current: string | null;
  /** Label for the reset row, e.g. "Automatic" or "No highlight". */
  resetLabel: string;
  /**
   * Colour the reset row previews. Null renders an empty "no colour" chip
   * (highlights), a value renders that colour (text follows the theme).
   */
  resetColor: string | null;
  swatches: string[];
  columns: number;
  onPick: (color: string) => void;
  onReset: () => void;
  /** Open the OS colour dialog for a colour that isn't in the grid. */
  onMore: () => void;
  onClose: () => void;
}

export function ColorMenu({
  x,
  y,
  current,
  resetLabel,
  resetColor,
  swatches,
  columns,
  onPick,
  onReset,
  onMore,
  onClose,
}: ColorMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(x, window.innerWidth - rect.width)),
      y: Math.max(0, Math.min(y, window.innerHeight - rect.height)),
    });
  }, [x, y]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep focus (and the editor's selection) where it was, so the colour applies
  // to what was selected when the menu opened.
  const keepSelection = (e: React.MouseEvent) => e.preventDefault();

  const same = (a: string | null, b: string) =>
    !!a && a.toLowerCase() === b.toLowerCase();

  return createPortal(
    <div
      ref={ref}
      className="v-colormenu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onMouseDown={keepSelection}
    >
      <button
        type="button"
        role="menuitem"
        className="v-colormenu__row"
        onClick={() => {
          onReset();
          onClose();
        }}
      >
        <span
          className={`v-colormenu__chip${resetColor ? "" : " v-colormenu__chip--none"}`}
          style={resetColor ? { background: resetColor } : undefined}
        />
        <span className="v-colormenu__label">{resetLabel}</span>
        {!current && <span className="v-colormenu__tick">✓</span>}
      </button>

      <div className="v-colormenu__sep" />

      <div
        className="v-colormenu__grid"
        style={{ gridTemplateColumns: `repeat(${columns}, auto)` }}
      >
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            role="menuitem"
            title={c}
            aria-label={c}
            className={`v-colormenu__swatch${same(current, c) ? " is-selected" : ""}`}
            style={{ background: c }}
            onClick={() => {
              onPick(c);
              onClose();
            }}
          />
        ))}
      </div>

      <div className="v-colormenu__sep" />

      <button
        type="button"
        role="menuitem"
        className="v-colormenu__row"
        onClick={() => {
          onClose();
          onMore();
        }}
      >
        <span className="v-colormenu__chip v-colormenu__chip--more">
          <Icon name="highlighter-color" />
        </span>
        <span className="v-colormenu__label">More colors…</span>
      </button>
    </div>,
    document.body,
  );
}
