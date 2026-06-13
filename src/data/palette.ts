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
];

export const DEFAULT_NOTEBOOK_COLOR = PALETTE[0].value;
export const DEFAULT_SECTION_COLOR = PALETTE[1].value;
