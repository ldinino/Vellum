// Notebook/section color palette (OneNote 2007-ish). Stored as hex in the DB /
// registry so rendering never depends on a CSS token being present.

export interface Swatch {
  name: string;
  value: string;
}

export const PALETTE: Swatch[] = [
  { name: "Blue", value: "#87a8e0" },
  { name: "Purple", value: "#b39bd6" },
  { name: "Green", value: "#9cc97e" },
  { name: "Orange", value: "#f0a86e" },
  { name: "Red", value: "#e08a8a" },
  { name: "Teal", value: "#76c5c0" },
  { name: "Yellow", value: "#e6d06e" },
  { name: "Magenta", value: "#d98ac2" },
  { name: "Gray", value: "#b4b0a6" },
];

export const DEFAULT_NOTEBOOK_COLOR = PALETTE[0].value;
export const DEFAULT_SECTION_COLOR = PALETTE[1].value;

/**
 * Text colours offered in the toolbar's font-colour dropdown, laid out as a
 * grid (greys, then warm, then cool). Deliberately the familiar Office set
 * rather than the pastel notebook palette above: these are ink colours, and a
 * pastel reads as illegible body text.
 *
 * These are absolute colours and are stored on the text, so they look the same
 * in both themes — "Automatic" (no colour at all) is what follows the theme.
 */
export const TEXT_SWATCHES: string[] = [
  "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
  "#c00000", "#ff0000", "#ff6600", "#ffc000", "#ffff00",
  "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0",
];

/**
 * Highlight colours — a smaller set, and deliberately all *light*. Highlights
 * are marker pens: the editor pins dark ink on top of them (see
 * `--text-on-highlight`) so a highlight stays readable in dark mode, which only
 * holds if the highlight itself is light. Offering a navy or black marker here
 * would render dark-on-dark.
 */
export const HIGHLIGHT_SWATCHES: string[] = [
  "#ffff00", "#a8ff60", "#7bf1ff", "#ff9ce8", "#a0c8ff",
  "#ffd08a", "#ffb3b3", "#d0b0ff", "#c8f0c8", "#d9d9d9",
];

/** Columns used to lay the swatch grids out. */
export const SWATCH_COLUMNS = 5;

/**
 * A pseudo-random palette color, assigned to newly created notebooks/sections
 * so they don't all default to the same swatch. The choice is persisted at
 * creation (picking at render time would reshuffle on every re-render).
 *
 * Uses a "shuffle bag" rather than an independent uniform pick each time: the
 * palette is shuffled once, colors are handed out from the front, and the bag
 * is only reshuffled once every color has been used. This guarantees no color
 * repeats until all the others have appeared, which reads as far more "random"
 * to people than true uniform sampling (whose normal short streaks of repeats
 * feel broken — the classic "shuffled playlist" complaint). The bag is
 * module-level state and resets on app restart, which is fine: this is a
 * cosmetic default, not persisted data.
 */
let colorBag: string[] = [];

function refillColorBag() {
  // Fisher–Yates shuffle of the palette values.
  colorBag = PALETTE.map((s) => s.value);
  for (let i = colorBag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colorBag[i], colorBag[j]] = [colorBag[j], colorBag[i]];
  }
}

export function randomPaletteColor(): string {
  if (colorBag.length === 0) refillColorBag();
  return colorBag.pop()!;
}
