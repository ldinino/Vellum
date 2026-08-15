/**
 * Settings → General (spec Section 15): appearance, and the Satchel picker.
 * Appearance writes `data-chrome`, `data-theme`, `data-scheme` and
 * `data-corners` on the document root, which every design token keys off (see
 * tokens.css and theme98.css). Satchels — the data roots themselves — live in
 * SatchelSettings.
 */

import { Button } from "../ui/Button";
import { useVellum } from "../../state/vellum";
import { SatchelSettings } from "./SatchelSettings";
import { PausedWhileHeld } from "./PausedWhileHeld";
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
  const { theme, themeScheme, cornerStyle, titlebarColors, actions } = useVellum();

  const family = FAMILY_OPTIONS.some((f) => f.value === theme) ? theme : "aero";
  const schemes = SCHEME_OPTIONS[family];
  const scheme = schemes.some((s) => s.value === themeScheme) ? themeScheme : schemes[0].value;
  const [defaultStart, defaultEnd] = SCHEME_TITLEBARS[scheme] ?? SCHEME_TITLEBARS.standard;
  const titlebarStart = titlebarColors?.start || defaultStart;
  const titlebarEnd = titlebarColors?.end || defaultEnd;

  return (
    <div className="v-set">
      {/* Appearance is persisted in app.json, inside the Satchel; the Satchel
          picker below is machine-local, so it stays usable while another
          device has this one (docs 5.7.1). */}
      <PausedWhileHeld>
      <section className="v-set__section">
        <h3 className="v-set__heading">Appearance</h3>
        <p className="v-set__hint">
          Choose your style and colour scheme. Aero for those who loved glass vibes, Windows 98 if you're feeling nostalgic.
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
          Corners round the section tabs, notebooks, and controls. Choose automatic to follow your theme.
        </p>
      </section>

      {family === "98" && (
        <section className="v-set__section">
          <h3 className="v-set__heading">Title bar colors</h3>
          <p className="v-set__hint">
            Windows 98 let you pick the two colors its title bar faded between. So does Vellum.
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
      </PausedWhileHeld>

      <SatchelSettings />
    </div>
  );
}
