/**
 * Settings → General (spec Section 15): appearance and the app data location.
 * Appearance writes `data-chrome`, `data-theme`, `data-scheme` and
 * `data-corners` on the document root, which every design token keys off (see
 * tokens.css and theme98.css). The data location shows where Vellum stores its
 * data (default `Documents\Vellum`, which OneDrive syncs) and lets the user
 * move it to a folder of their choice — e.g. a local, non-synced folder so
 * OneDrive stops making duplicate copies of the live databases and search
 * index. Changing it moves the data, then restarts the app so everything
 * reloads from the new location.
 */

import { useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "../ui/Button";
import { useActiveEditor } from "../../state/activeEditor";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import "./SettingsPanels.css";

const FAMILY_OPTIONS = [
  { value: "aero", label: "Aero (Office 2007)" },
  { value: "98", label: "Windows 98" },
];

const SCHEME_OPTIONS: Record<string, { value: string; label: string }[]> = {
  aero: [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "oled", label: "Dark (OLED black)" },
  ],
  "98": [
    { value: "standard", label: "Windows Standard" },
    { value: "dark", label: "Dark" },
    { value: "eggplant", label: "Eggplant" },
    { value: "spruce", label: "Spruce" },
    { value: "rose", label: "Rose" },
    { value: "desert", label: "Desert" },
    { value: "storm", label: "Storm (VGA)" },
  ],
};

const CORNER_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "rounded", label: "Rounded" },
  { value: "square", label: "Square" },
];

/** Each 98 scheme's own title bar gradient, so the colour pickers start from
 * the active scheme instead of black when nothing is overridden. Keep in sync
 * with the `--titlebar-start` / `--titlebar-end` values in theme98.css. */
const SCHEME_TITLEBARS: Record<string, [string, string]> = {
  standard: ["#000080", "#1084d0"],
  dark: ["#1f1f1f", "#3c3c3c"],
  eggplant: ["#40364c", "#6c5b7f"],
  spruce: ["#0a4a3c", "#1f8a6d"],
  rose: ["#6b2438", "#a85068"],
  desert: ["#6b5a2a", "#806b38"],
  storm: ["#2c3e50", "#5a7a99"],
};

export function GeneralSettings() {
  const [currentPath, setCurrentPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { active } = useActiveEditor();
  const { theme, themeScheme, cornerStyle, titlebarColors, actions } = useVellum();

  const family = FAMILY_OPTIONS.some((f) => f.value === theme) ? theme : "aero";
  const schemes = SCHEME_OPTIONS[family];
  const scheme = schemes.some((s) => s.value === themeScheme) ? themeScheme : schemes[0].value;
  const [defaultStart, defaultEnd] = SCHEME_TITLEBARS[scheme] ?? SCHEME_TITLEBARS.standard;
  const titlebarStart = titlebarColors?.start || defaultStart;
  const titlebarEnd = titlebarColors?.end || defaultEnd;

  useEffect(() => {
    let alive = true;
    api
      .getPaths()
      .then((p) => alive && setCurrentPath(p.dataDir))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Pick a new parent folder, move the data into `<parent>\Vellum`, then restart
  // so the app reloads everything from the new location.
  async function changeLocation() {
    const parent = await open({
      directory: true,
      title: "Choose where to store Vellum data",
    });
    if (typeof parent !== "string") return;

    const ok = await ask(
      `Vellum will move all your notebooks and settings to:\n\n${parent}\\Vellum\n\nThe app will restart to finish. Continue?`,
      { title: "Change data location", kind: "warning" },
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      // Persist the open page before its database is moved (flushSaves is absent
      // when no editor is mounted, hence Promise.resolve).
      await Promise.resolve(active?.flushSaves()).catch(() => {});
      const newPath = await api.setDataDir(parent);
      // Picking the current location is a no-op — no need to restart.
      if (newPath === currentPath) {
        setBusy(false);
        return;
      }
      await relaunch();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">Appearance</h3>
        <p className="v-set__hint">
          Aero is the Office 2007 look, with a glass title bar. Windows 98 swaps in flat grey
          chrome, a solid title bar, and the 3D bevelled controls of the era. Dark schemes use a
          dark page and toolbars throughout the app; printing and exported documents stay light.
        </p>
        <div className="v-set__row">
          <label className="v-set__field">
            <span className="v-set__label">Theme</span>
            <select
              className="v-set__select v-set__select--size"
              value={family}
              onChange={(e) => void actions.setAppearance({ family: e.target.value })}
            >
              {FAMILY_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="v-set__field">
            <span className="v-set__label">Colour scheme</span>
            <select
              className="v-set__select v-set__select--size"
              value={scheme}
              onChange={(e) => void actions.setAppearance({ scheme: e.target.value })}
            >
              {schemes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="v-set__field">
            <span className="v-set__label">Corners</span>
            <select
              className="v-set__select v-set__select--size"
              value={CORNER_OPTIONS.some((c) => c.value === cornerStyle) ? cornerStyle : "auto"}
              onChange={(e) => void actions.setAppearance({ cornerStyle: e.target.value })}
            >
              {CORNER_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="v-set__hint">
          Corners round the section tabs, notebooks and controls. Automatic follows the theme —
          rounded in Aero, square in Windows 98.
        </p>
      </section>

      {family === "98" && (
        <section className="v-set__section">
          <h3 className="v-set__heading">Title bar colours</h3>
          <p className="v-set__hint">
            Windows 98 let you pick the two colours its title bar faded between. So does Vellum.
          </p>
          <div className="v-set__row">
            <label className="v-set__field">
              <span className="v-set__label">Left</span>
              <input
                type="color"
                className="v-set__color"
                value={titlebarStart}
                onChange={(e) =>
                  void actions.setAppearance({
                    titlebarColors: { start: e.target.value, end: titlebarEnd },
                  })
                }
              />
            </label>
            <label className="v-set__field">
              <span className="v-set__label">Right</span>
              <input
                type="color"
                className="v-set__color"
                value={titlebarEnd}
                onChange={(e) =>
                  void actions.setAppearance({
                    titlebarColors: { start: titlebarStart, end: e.target.value },
                  })
                }
              />
            </label>
            <div
              className="v-set__gradient-preview"
              style={{ background: `linear-gradient(90deg, ${titlebarStart}, ${titlebarEnd})` }}
              aria-hidden="true"
            />
            <Button
              onClick={() => void actions.setAppearance({ titlebarColors: null })}
              disabled={!titlebarColors}
            >
              Reset
            </Button>
          </div>
        </section>
      )}

      <section className="v-set__section">
        <h3 className="v-set__heading">App data location</h3>
        <p className="v-set__hint">
          Your notebooks, attachments, and settings are stored here. On Windows this folder is
          backed up by OneDrive automatically. You can move it elsewhere — for example, a folder
          outside OneDrive — to stop OneDrive from making duplicate copies of open notebooks.
        </p>
        <div className="v-set__pathrow">
          <code className="v-set__path">{currentPath || (error ? "Unavailable" : "…")}</code>
          <Button
            icon="blue-folder"
            onClick={() => void api.revealDataDir()}
            disabled={!currentPath || busy}
          >
            Open folder
          </Button>
          <Button
            icon="blue-folder--arrow"
            onClick={() => void changeLocation()}
            disabled={!currentPath || busy}
          >
            {busy ? "Moving…" : "Change…"}
          </Button>
        </div>
        {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
      </section>
    </div>
  );
}
