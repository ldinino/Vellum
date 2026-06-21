import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Whether the Tauri window is currently maximized. Used to square the window
 * corners and drop the glass frame when maximized (a rounded/bordered maximized
 * window would show desktop gaps at the screen corners), and to pick the
 * restore-vs-maximize caption glyph. No-op outside Tauri (npm run dev in a
 * plain browser), where it stays false.
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  return maximized;
}
