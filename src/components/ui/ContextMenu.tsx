import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase so a click on anything else closes first.
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="v-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
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
            ].join(" ")}
            disabled={item.disabled}
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
              ) : item.checked ? (
                <Icon name="tick" />
              ) : (
                item.icon && <Icon name={item.icon} />
              )}
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
