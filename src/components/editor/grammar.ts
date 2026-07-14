/**
 * Bridges Harper's plain-text lint spans (spec Section 10) to ProseMirror.
 *
 * Harper works on plain text and returns UTF-16 offsets into it; we extract the
 * document's text (with newlines between blocks so Harper sees sentence
 * boundaries) while recording, for each text node, the mapping from text offset
 * to ProseMirror position. A returned span is then mapped back to a doc range.
 *
 * The "Ignore" / "Ignore Rule" sets are per app-session and span page switches,
 * so they live at module scope (reset on app restart).
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { GrammarSpan } from "../../data/types";

/** One text node's place in the extracted string. `length` is UTF-16 units. */
interface Segment {
  from: number; // ProseMirror position of the node's first character
  textStart: number; // offset of this node's text within the extracted string
  length: number;
}

export interface ExtractedText {
  text: string;
  segments: Segment[];
}

/** A backend span resolved to live document coordinates plus its lint data. */
export interface MappedLint {
  from: number;
  to: number;
  message: string;
  kind: string;
  /** Misspelling vs grammar lint — selects the underline + context menu. */
  isSpelling: boolean;
  suggestions: string[];
  /** Stable, content-based identity for per-session "Ignore". */
  instanceKey: string;
}

/**
 * Walk the doc, building the plain text Harper sees and the offset→position map.
 * A blank line (two newlines) is inserted between blocks so Harper's sentence
 * tokenizer treats paragraph boundaries as sentence boundaries. A single
 * newline is not a strong enough break: a paragraph ending in a non-terminating
 * character (e.g. a colon, "Overview:") would otherwise be merged with the
 * following paragraph into one sentence and mis-flagged as an over-long
 * run-on. A blank line reads as a hard paragraph break in every sentence
 * tokenizer.
 */
export function extractText(doc: PMNode): ExtractedText {
  const segments: Segment[] = [];
  let text = "";
  let pendingBreak = false;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (pendingBreak && text.length > 0) text += "\n\n";
      pendingBreak = false;
      segments.push({ from: pos, textStart: text.length, length: node.text.length });
      text += node.text;
      return false; // text nodes have no children to visit
    }
    if (node.isBlock) {
      // Entering a block: the next text should start after a blank line.
      pendingBreak = true;
    }
    return true;
  });

  return { text, segments };
}

/**
 * Map a text offset to a ProseMirror position, or null if it falls in a gap.
 *
 * `segments` is in document order, so `textStart` is strictly increasing and the
 * ranges are non-overlapping — a binary search makes each lookup O(log n). The
 * old linear scan was O(segments) per offset, so mapping every span on a very
 * large page (thousands of text nodes) was O(spans × segments) and could stall
 * the UI thread. Find the last segment starting at or before `offset`, then
 * confirm `offset` lands within that node's text rather than in a following gap
 * (the blank line inserted between blocks).
 */
function mapOffset(segments: Segment[], offset: number): number | null {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].textStart <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const s = segments[found];
  if (offset <= s.textStart + s.length) {
    return s.from + (offset - s.textStart);
  }
  return null;
}

/** Which lint categories to surface — spelling and grammar toggle independently
 * (spec Section 15: separate Editor "spell check" and Grammar toggles). */
export interface LintToggles {
  grammar: boolean;
  spell: boolean;
}

/**
 * Resolve backend spans to document ranges, dropping any that fall outside the
 * text nodes (e.g. a span landing on an inter-block newline), belong to a
 * disabled category, or that the user has ignored this session.
 */
export function mapLints(
  spans: GrammarSpan[],
  extracted: ExtractedText,
  toggles: LintToggles,
): MappedLint[] {
  const out: MappedLint[] = [];
  for (const s of spans) {
    if (s.isSpelling ? !toggles.spell : !toggles.grammar) continue;
    if (ignoredRules.has(s.kind)) continue;
    const from = mapOffset(extracted.segments, s.start);
    const to = mapOffset(extracted.segments, s.end);
    if (from == null || to == null || from >= to) continue;
    const matched = extracted.text.slice(s.start, s.end);
    const instanceKey = `${s.kind}|${s.message}|${matched}`;
    if (ignoredInstances.has(instanceKey)) continue;
    out.push({
      from,
      to,
      message: s.message,
      kind: s.kind,
      isSpelling: s.isSpelling,
      suggestions: s.suggestions,
      instanceKey,
    });
  }
  return out;
}

// ---- Per-session ignore sets ----------------------------------------------

const ignoredRules = new Set<string>();
const ignoredInstances = new Set<string>();

/** Replace the set of ignored rule kinds (loaded from persisted settings, spec
 * Section 10). Keeps the live underline filter in sync with Settings → Proofing. */
export function setIgnoredRules(kinds: string[]) {
  ignoredRules.clear();
  for (const k of kinds) ignoredRules.add(k);
}

/** Stop ignoring a rule kind; its underlines return on the next lint. */
export function unignoreRule(kind: string) {
  ignoredRules.delete(kind);
}

export function ignoreInstance(instanceKey: string) {
  ignoredInstances.add(instanceKey);
}
