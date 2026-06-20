/**
 * Compact search box (spec Section 11), docked at the right of the top toolbar.
 * A query field with a scope dropdown (This Section / This Notebook / All
 * Notebooks) and a results overlay. Results update as the user types (200ms
 * debounce); clicking a result opens its page and highlights the matches there.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import type { SearchFilters, SearchHit } from "../../data/types";
import "./SearchBar.css";

const HL_OPEN = "";
const HL_CLOSE = "";

type Scope = "all" | "notebook" | "section";

/** Render a backend snippet, turning the U+0001/U+0002 markers into <mark>. */
function renderSnippet(snippet: string) {
  const out: React.ReactNode[] = [];
  let buf = "";
  let marked = false;
  let key = 0;
  const flush = () => {
    if (!buf) return;
    out.push(marked ? <mark key={key++}>{buf}</mark> : <Fragment key={key++}>{buf}</Fragment>);
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === HL_OPEN) {
      flush();
      marked = true;
    } else if (ch === HL_CLOSE) {
      flush();
      marked = false;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

/** Highlight whole-query terms inside a plain string (used for the title). */
function highlightTitle(text: string, terms: string[]) {
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "i");
  return text.split(re).map((part, i) => {
    if (part === "") return null;
    return i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>;
  });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function SearchBox() {
  const { actions, selectedNotebookId, selectedSectionId } = useVellum();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search whenever the query, scope, or current selection changes.
  // Scope is relative to the open notebook/section (OneNote-style); an invalid
  // scope (e.g. "This Section" with nothing selected) degrades to all notebooks.
  useEffect(() => {
    if (query.trim() === "") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(() => {
      const filters: SearchFilters = {};
      if (scope === "notebook" && selectedNotebookId) {
        filters.notebookIds = [selectedNotebookId];
      } else if (scope === "section" && selectedNotebookId && selectedSectionId) {
        filters.notebookIds = [selectedNotebookId];
        filters.sectionId = selectedSectionId;
      }
      api
        .search(query, filters)
        .then((hits) => setResults(hits))
        .catch((e) => console.error("search failed", e))
        .finally(() => setLoading(false));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, scope, selectedNotebookId, selectedSectionId]);

  // Close the results overlay on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const terms = useMemo(() => query.split(/\s+/).filter(Boolean), [query]);

  const onPick = (hit: SearchHit) => {
    setOpen(false);
    void actions.openPage(hit.notebookId, hit.sectionId, hit.pageId, query);
  };

  return (
    <div className="v-search" ref={containerRef}>
      <div className="v-search__field">
        <Icon name="magnifier" className="v-search__field-icon" />
        <input
          type="text"
          className="v-search__input"
          placeholder="Search notebooks…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(e.target.value.trim() !== "");
          }}
          onFocus={() => query.trim() !== "" && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {query && (
          <button
            type="button"
            className="v-search__clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setResults([]);
              setOpen(false);
            }}
          >
            <Icon name="cross-small" />
          </button>
        )}
        <select
          className="v-search__scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
          aria-label="Search scope"
          title="Search in"
        >
          <option value="section" disabled={!selectedSectionId}>
            This Section
          </option>
          <option value="notebook" disabled={!selectedNotebookId}>
            This Notebook
          </option>
          <option value="all">All Notebooks</option>
        </select>
      </div>

      {open && query.trim() !== "" && (
        <div className="v-search__results" role="listbox">
          {loading && results.length === 0 ? (
            <div className="v-search__status">Searching…</div>
          ) : results.length === 0 ? (
            <div className="v-search__status">No results for “{query.trim()}”.</div>
          ) : (
            results.map((hit) => (
              <button
                key={hit.pageId}
                type="button"
                className="v-search__result"
                onClick={() => onPick(hit)}
                role="option"
              >
                <div className="v-search__crumb">
                  <Icon name="book" />
                  <span>{hit.notebookName}</span>
                  <span className="v-search__sep">›</span>
                  <span>{hit.sectionName}</span>
                </div>
                <div className="v-search__title">
                  {highlightTitle(hit.title || "Untitled page", terms)}
                  {hit.hasAttachment && (
                    <Icon name="paper-clip-small" className="v-search__attach" label="Has attachment" />
                  )}
                </div>
                {hit.snippet && (
                  <div className="v-search__snippet">{renderSnippet(hit.snippet)}</div>
                )}
                <div className="v-search__meta">{formatDate(hit.updatedAt)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
