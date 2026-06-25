/**
 * Settings → Editor (spec Section 15): the default font + size for page text.
 * These drive `--editor-font` / `--editor-font-size` on the document root (see
 * vellum.tsx `applyEditorFont` + editor.css), so unstyled text picks them up
 * live; explicit toolbar formatting still overrides per selection.
 */

import { useVellum } from "../../state/vellum";
import { FONTS, SIZES } from "../../data/fonts";
import "./SettingsPanels.css";

export function EditorSettings() {
  const { defaultFont, defaultFontSize, actions } = useVellum();

  // Keep the current value selectable even if it isn't one of the presets.
  const fontOptions = FONTS.includes(defaultFont) ? FONTS : [defaultFont, ...FONTS];
  const sizeStr = String(defaultFontSize);
  const sizeOptions = SIZES.includes(sizeStr) ? SIZES : [sizeStr, ...SIZES];

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">Default font</h3>
        <p className="v-set__hint">
          New pages and unformatted text use this font and size. You can still change the font of
          any selection from the toolbar.
        </p>
        <div className="v-set__row">
          <label className="v-set__field">
            <span className="v-set__label">Font</span>
            <select
              className="v-set__select"
              value={defaultFont}
              onChange={(e) => void actions.setDefaultFont(e.target.value)}
            >
              {fontOptions.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="v-set__field">
            <span className="v-set__label">Size</span>
            <select
              className="v-set__select v-set__select--size"
              value={sizeStr}
              onChange={(e) => void actions.setDefaultFontSize(Number(e.target.value))}
            >
              {sizeOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p
          className="v-set__preview"
          style={{ fontFamily: `"${defaultFont}"`, fontSize: `${defaultFontSize}px` }}
        >
          The quick brown fox jumps over the lazy dog.
        </p>
      </section>
    </div>
  );
}
