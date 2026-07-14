/**
 * Live template fields (execution-plan #7) — pure date/time formatting.
 *
 * "Live" fields are an inline Tiptap node (`DynamicField`) that re-evaluates its
 * value every time the page loads, unlike the one-shot `{{Token}}` placeholders
 * which the backend stamps once at page-creation time. This module holds only
 * the formatting logic (no React/Tiptap), so both the node's NodeView and the
 * Markdown exporter can share it.
 *
 * Formatting is deliberate and locale-independent (English, 12-hour clock) so a
 * field reads the same on every machine — matching the app's English-only scope
 * and the backend's one-shot date formats (src-tauri/src/commands.rs), so a
 * `{{CurrentDate}}` token and a live date field with the default format render
 * identically.
 */

export type DynamicFieldKind = "date" | "time" | "datetime";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const dateLong = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const dateMedium = (d: Date) => `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const dateUS = (d: Date) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
const dateISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const time12 = (d: Date) => {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
};
const time24 = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

interface FieldPreset {
  /** Stored in the node's `format` attribute; also the token used in labels. */
  key: string;
  render: (d: Date) => string;
}

/**
 * The format presets offered per field kind (execution-plan #7 chose a small
 * preset list over hand-typed format strings). The first entry of each kind is
 * the default, and its output matches the backend one-shot token format.
 */
export const DYNAMIC_FIELD_PRESETS: Record<DynamicFieldKind, FieldPreset[]> = {
  date: [
    { key: "MMMM D, YYYY", render: dateLong },
    { key: "MMM D, YYYY", render: dateMedium },
    { key: "MM/DD/YYYY", render: dateUS },
    { key: "YYYY-MM-DD", render: dateISO },
  ],
  time: [
    { key: "h:mm A", render: time12 },
    { key: "HH:mm", render: time24 },
  ],
  datetime: [
    { key: "MMMM D, YYYY h:mm A", render: (d) => `${dateLong(d)} ${time12(d)}` },
    { key: "YYYY-MM-DD HH:mm", render: (d) => `${dateISO(d)} ${time24(d)}` },
  ],
};

/** The default format key for a kind (its first preset). */
export function defaultFieldFormat(kind: DynamicFieldKind): string {
  return DYNAMIC_FIELD_PRESETS[kind][0].key;
}

/**
 * Render a live field's current value. Falls back to the kind's default preset
 * when `format` is missing or unrecognized, so a field always renders something.
 */
export function formatDynamicField(
  kind: DynamicFieldKind,
  format?: string | null,
  d: Date = new Date(),
): string {
  const presets = DYNAMIC_FIELD_PRESETS[kind] ?? DYNAMIC_FIELD_PRESETS.date;
  const preset = presets.find((p) => p.key === format) ?? presets[0];
  return preset.render(d);
}
