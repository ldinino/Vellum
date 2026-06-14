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
  suggestions: string[];
  /** Stable, content-based identity for per-session "Ignore". */
  instanceKey: string;
}

/**
 * Walk the doc, building the plain text Harper sees and the offset→position map.
 * A newline is inserted between blocks (mirroring `doc.textBetween(_, _, "\n")`)
 * so sentence/paragraph boundaries are preserved.
 */
export function extractText(doc: PMNode): ExtractedText {
  const segments: Segment[] = [];
  let text = "";
  let pendingBreak = false;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (pendingBreak && text.length > 0) text += "\n";
      pendingBreak = false;
      segments.push({ from: pos, textStart: text.length, length: node.text.length });
      text += node.text;
      return false; // text nodes have no children to visit
    }
    if (node.isBlock) {
      // Entering a block: the next text should start on a new line.
      pendingBreak = true;
    }
    return true;
  });

  return { text, segments };
}

/** Map a text offset to a ProseMirror position, or null if it falls in a gap. */
function mapOffset(segments: Segment[], offset: number): number | null {
  for (const s of segments) {
    if (offset >= s.textStart && offset <= s.textStart + s.length) {
      return s.from + (offset - s.textStart);
    }
  }
  return null;
}

/**
 * Resolve backend spans to document ranges, dropping any that fall outside the
 * text nodes (e.g. a span landing on an inter-block newline) or that the user
 * has ignored this session.
 */
export function mapLints(spans: GrammarSpan[], extracted: ExtractedText): MappedLint[] {
  const out: MappedLint[] = [];
  for (const s of spans) {
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
      suggestions: s.suggestions,
      instanceKey,
    });
  }
  return out;
}

// ---- Per-session ignore sets ----------------------------------------------

const ignoredRules = new Set<string>();
const ignoredInstances = new Set<string>();

export function ignoreRule(kind: string) {
  ignoredRules.add(kind);
}

export function ignoreInstance(instanceKey: string) {
  ignoredInstances.add(instanceKey);
}
