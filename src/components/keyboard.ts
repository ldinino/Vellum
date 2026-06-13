import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Arrow-key navigation for a focusable list/tree. Attach to the container;
 * ArrowUp/Down move focus between rows matching `selector`, Enter activates the
 * focused row. Other keys (F2, etc.) are left for the rows themselves.
 */
export function handleListArrows(
  e: ReactKeyboardEvent<HTMLElement>,
  selector: string,
) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
  const active = document.activeElement as HTMLElement | null;
  if (e.key === "Enter") {
    if (active && e.currentTarget.contains(active)) {
      e.preventDefault();
      active.click();
    }
    return;
  }
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (rows.length === 0) return;
  const idx = active ? rows.indexOf(active) : -1;
  const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
  if (next >= 0 && next < rows.length) {
    e.preventDefault();
    rows[next].focus();
  }
}
