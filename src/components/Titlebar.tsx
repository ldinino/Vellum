import { getCurrentWindow } from "@tauri-apps/api/window";
import "./Titlebar.css";

/**
 * Custom window titlebar (decorations: false). Authentic Aero glass + 7.css
 * caption buttons (see Titlebar.css). `maximized` is owned by App (so the
 * window frame can square its corners too) and selects the restore/maximize
 * glyph. Falls back gracefully in a plain browser (npm run dev) where the Tauri
 * window API is unavailable.
 */
export function Titlebar({
  title = "Vellum",
  maximized = false,
}: {
  title?: string;
  maximized?: boolean;
}) {
  const inTauri = "__TAURI_INTERNALS__" in window;

  const control = (action: "minimize" | "toggleMaximize" | "close") => () => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    win[action]().catch(() => {});
  };

  return (
    <div className="v-titlebar" data-tauri-drag-region>
      <img
        src="/app-icon.png"
        className="v-titlebar__appicon"
        alt=""
        aria-hidden="true"
        data-tauri-drag-region
      />
      <span className="v-titlebar__title" data-tauri-drag-region>
        {title}
      </span>
      {/* Caption-button glyphs are drawn in CSS (Aero PNGs from 7.css), keyed
          on each button's aria-label — see Titlebar.css. */}
      <div className="v-titlebar__controls">
        <button
          type="button"
          className="v-titlebar__btn"
          aria-label="Minimize"
          onClick={control("minimize")}
        />
        <button
          type="button"
          className="v-titlebar__btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={control("toggleMaximize")}
        />
        <button
          type="button"
          className="v-titlebar__btn v-titlebar__btn--close"
          aria-label="Close"
          onClick={control("close")}
        />
      </div>
    </div>
  );
}
