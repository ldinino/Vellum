import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, IconName } from "./Icon";
import "./ContextMenu.css";

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Render a color chip instead of an icon (used by Change color menus). */
  swatch?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Show a check mark (e.g. the currently selected color). */
  checked?: boolean;
  onSelect?: () => void;
  /** Nested items render a "label ▶" submenu (e.g. Refine ▶ templates). */
  submenu?: MenuItem[];
  separatorAfter?: boolean;
}

interface ContextMenuProps {
  items: MenuItem[];
  /** Viewport position; menu clamps itself on overflow. */
  x: number;
  y: number;
  onClose: () => void;
}

/** Bordered, shadowed Office-style context menu with submenu support. */
export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
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
    // Close only on a mousedown that lands OUTSIDE the menu (and its submenus,
    // which render as nested children of `ref`). A blind capture-phase close
    // would unmount the menu before the item's own click could fire, so no
    // item would ever activate.
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

  // Portaled to <body> so the (position:fixed) menu always paints above page
  // chrome — section tabs, the editor, etc. — regardless of any ancestor
  // stacking context where it's invoked.
  return createPortal(
    <div ref={ref} className="v-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <MenuList items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);

  return (
    <>
      {items.map((item, i) => (
        <div key={i}>
          <button
            type="button"
            role="menuitem"
            className={[
              "v-menu__item",
              item.danger ? "v-menu__item--danger" : "",
              item.checked ? "v-menu__item--checked" : "",
            ].join(" ")}
            disabled={item.disabled}
            // Keep focus (and the editor/input selection) where it was when the
            // menu opened, so Cut/Copy/Paste act on the right selection. Click
            // still fires — preventing mousedown only blocks the focus shift.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setOpenSub(item.submenu ? i : null)}
            onClick={() => {
              if (item.submenu) return;
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="v-menu__icon">
              {item.swatch ? (
                <span
                  className="v-menu__swatch"
                  style={{ background: item.swatch }}
                />
              ) : item.icon ? (
                <Icon name={item.icon} />
              ) : item.checked ? (
                <Icon name="tick" />
              ) : null}
            </span>
            <span className="v-menu__label">{item.label}</span>
            {item.submenu && <span className="v-menu__arrow">▶</span>}
            {item.submenu && openSub === i && (
              <div className="v-menu v-menu--submenu" role="menu">
                <MenuList items={item.submenu} onClose={onClose} />
              </div>
            )}
          </button>
          {item.separatorAfter && <div className="v-menu__separator" />}
        </div>
      ))}
    </>
  );
}

/** Hook: wire onContextMenu to show, render `menu` into your tree. */
export function useContextMenu(items: MenuItem[]) {
  const [state, setState] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY });
  };
  const menu = state ? (
    <ContextMenu items={items} x={state.x} y={state.y} onClose={() => setState(null)} />
  ) : null;
  return { onContextMenu, menu };
}
