import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./Titlebar.css";

/**
 * Custom window titlebar (decorations: false). Aero-glass treatment with
 * gradient/sheen values referenced from makeaero's window-glass generator.
 * Falls back gracefully in a plain browser (npm run dev) where the Tauri
 * window API is unavailable.
 */
export function Titlebar({ title = "Vellum" }: { title?: string }) {
  const [maximized, setMaximized] = useState(false);
  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, [inTauri]);

  const control = (action: "minimize" | "toggleMaximize" | "close") => () => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    win[action]().catch(() => {});
  };

  return (
    <div className="v-titlebar" data-tauri-drag-region>
      <img
        src="/tauri.svg"
        className="v-titlebar__appicon"
        alt=""
        aria-hidden="true"
        data-tauri-drag-region
      />
      <span className="v-titlebar__title" data-tauri-drag-region>
        {title}
      </span>
      <div className="v-titlebar__controls">
        <button
          type="button"
          className="v-titlebar__btn"
          aria-label="Minimize"
          onClick={control("minimize")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="7" width="8" height="2" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="v-titlebar__btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={control("toggleMaximize")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M3 1h6v6h-2V3H3V1zM1 3h6v6H1V3zm1 1v4h4V4H2z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1h8v8H1V1zm1 2v5h6V3H2z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="v-titlebar__btn v-titlebar__btn--close"
          aria-label="Close"
          onClick={control("close")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1.4 0 5 3.6 8.6 0 10 1.4 6.4 5 10 8.6 8.6 10 5 6.4 1.4 10 0 8.6 3.6 5 0 1.4z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
