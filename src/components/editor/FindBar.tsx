import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useActiveEditor } from "../../state/activeEditor";
import { clearFind, findNext, findPrev, setFindQuery, type FindStats } from "./find";
import "./FindBar.css";

/**
 * In-page find box (Ctrl+F): a small bar floating at the lower-right of the page
 * "desk", tinted with the open section's color (via the inherited
 * --section-color). Mounted only while find is open and clears its highlights on
 * unmount. Enter / Shift+Enter cycle matches; Esc closes.
 */
export function FindBar({ onClose, focusTick }: { onClose: () => void; focusTick: number }) {
  const { active } = useActiveEditor();
  const editor = active?.editor ?? null;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<FindStats>({ count: 0, current: -1 });

  const run = useCallback(
    (q: string) => {
      setQuery(q);
      setStats(editor ? setFindQuery(editor, q) : { count: 0, current: -1 });
    },
    [editor],
  );
  const next = useCallback(() => {
    if (editor) setStats(findNext(editor));
  }, [editor]);
  const prev = useCallback(() => {
    if (editor) setStats(findPrev(editor));
  }, [editor]);

  // Focus + select on open, and again on each Ctrl+F while already open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // On mount (and whenever the open page changes), seed from any selected text
  // and (re)apply the query to the now-active editor.
  useEffect(() => {
    if (!editor) {
      setStats({ count: 0, current: -1 });
      return;
    }
    const { from, to } = editor.state.selection;
    const selected = from !== to ? editor.state.doc.textBetween(from, to, " ").trim() : "";
    const q = selected && selected.length <= 100 ? selected : query;
    setQuery(q);
    setStats(q ? setFindQuery(editor, q) : { count: 0, current: -1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Clear highlights when the bar closes (unmount) or the editor swaps out.
  useEffect(() => {
    return () => {
      if (editor) clearFind(editor);
    };
  }, [editor]);

  const counter =
    stats.count > 0 ? `${stats.current + 1}/${stats.count}` : query ? "0/0" : "";

  return (
    <div className="v-find" role="search">
      <Icon name="magnifier" className="v-find__glass" />
      <input
        ref={inputRef}
        type="text"
        className="v-find__input"
        placeholder="Find on page"
        value={query}
        onChange={(e) => run(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="v-find__count" aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className="v-find__btn"
        onClick={prev}
        disabled={stats.count === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <Icon name="arrow-090" />
      </button>
      <button
        type="button"
        className="v-find__btn"
        onClick={next}
        disabled={stats.count === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <Icon name="arrow-270" />
      </button>
      <button
        type="button"
        className="v-find__btn"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        <Icon name="cross-small" />
      </button>
    </div>
  );
}
