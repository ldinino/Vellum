/**
 * Compact search box (spec Section 11), pinned at the right of the section-tab
 * row (above the page strip). A query field with a scope dropdown (This Section /
 * This Notebook / All Notebooks) and a results overlay. Results update as the
 * user types (200ms debounce); clicking a result opens its page and highlights
 * the matches there.
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/Icon";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import type { SearchFilters, SearchHit } from "../../data/types";
import "./SearchBar.css";

// The backend wraps matched runs with these control chars (see search.rs
// HL_OPEN/HL_CLOSE); the snippet renderer splits on them to emit <mark>.
const HL_OPEN = "";
const HL_CLOSE = "";

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

/**
 * Highlight whole words that start with any query term, mirroring the backend's
 * prefix-on-token matching (search.rs fts_query builds `"term"*`). Matching the
 * backend keeps title and snippet highlights consistent and, crucially, avoids
 * fragmenting a word into many padded single-character <mark>s for short queries
 * (the "bizarre letter spacing" a query like "s" otherwise produced).
 */
function highlightTitle(text: string, terms: string[]) {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (needles.length === 0) return text;
  // Split into alternating word / non-word runs (FTS tokens are alphanumeric).
  const chunks = text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) ?? [text];
  return chunks.map((chunk, i) => {
    const isWord = /[\p{L}\p{N}]/u.test(chunk);
    const lower = chunk.toLowerCase();
    return isWord && needles.some((n) => lower.startsWith(n)) ? (
      <mark key={i}>{chunk}</mark>
    ) : (
      <Fragment key={i}>{chunk}</Fragment>
    );
  });
}

/**
 * Does any whole word in `text` start with one of the query terms? Mirrors
 * `highlightTitle`'s tokenization (and the backend's prefix-on-token match) so
 * the result list flags exactly the attachment filenames the query hit.
 */
function nameMatchesTerms(text: string, terms: string[]) {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (needles.length === 0) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((w) => needles.some((n) => w.toLowerCase().startsWith(n)));
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

const SCOPE_LABEL: Record<Scope, string> = {
  all: "All Notebooks",
  notebook: "This Notebook",
  section: "This Section",
};

export function SearchBox() {
  const { actions, selectedNotebookId, selectedSectionId } = useVellum();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // The scope picker (a ContextMenu under the magnifier) and the results overlay
  // both render with fixed positioning so they escape the shell's overflow:hidden
  // clip — otherwise the dropdown is cut off below the bar.
  const [scopeMenu, setScopeMenu] = useState<{ x: number; y: number } | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

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

  // Close the results overlay on outside click. Skip while the scope menu is
  // open: the results are ducked then, and that menu (portaled to <body>) would
  // otherwise count as "outside" and tear down `open`, so picking a scope
  // wouldn't bring the suggestions back. The ContextMenu handles its own close.
  useEffect(() => {
    if (!open || scopeMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The overlay is portaled to <body>, so it's not inside containerRef —
      // exclude it explicitly or clicking a result would close before it fires.
      if (containerRef.current?.contains(t) || overlayRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, scopeMenu]);

  // Pin the results overlay just under the field (fixed coords, right-aligned to
  // the field's right edge), recomputed each time it opens.
  useLayoutEffect(() => {
    if (!open) return;
    const r = fieldRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 3, right: window.innerWidth - r.right });
  }, [open]);

  const terms = useMemo(() => query.split(/\s+/).filter(Boolean), [query]);

  const toggleScopeMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (scopeMenu) {
      setScopeMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setScopeMenu({ x: r.left, y: r.bottom + 2 });
  };

  // OneNote's "Search In:" list: a disabled header, then the three scopes with a
  // tick on the active one. This/Notebook/Section disable when nothing's open.
  const scopeItems: MenuItem[] = [
    { label: "Search In:", disabled: true, separatorAfter: true },
    {
      label: SCOPE_LABEL.section,
      checked: scope === "section",
      disabled: !selectedSectionId,
      onSelect: () => setScope("section"),
    },
    {
      label: SCOPE_LABEL.notebook,
      checked: scope === "notebook",
      disabled: !selectedNotebookId,
      onSelect: () => setScope("notebook"),
    },
    {
      label: SCOPE_LABEL.all,
      checked: scope === "all",
      onSelect: () => setScope("all"),
    },
  ];

  const onPick = (hit: SearchHit) => {
    setOpen(false);
    void actions.openPage(hit.notebookId, hit.sectionId, hit.pageId, query);
  };

  return (
    <div className="v-search" ref={containerRef}>
      <div className="v-search__field" ref={fieldRef}>
        <input
          type="text"
          className="v-search__input"
          placeholder={`Search ${SCOPE_LABEL[scope]}`}
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
        {/* Magnifier doubles as the scope dropdown (OneNote combo): click to
            pick This Section / This Notebook / All Notebooks. */}
        <button
          type="button"
          className="v-search__menu"
          aria-label="Search scope"
          title={`Search in: ${SCOPE_LABEL[scope]}`}
          onClick={toggleScopeMenu}
        >
          <Icon name="magnifier" className="v-search__menu-icon" />
          <span className="v-search__caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>

      {scopeMenu && (
        <ContextMenu
          items={scopeItems}
          x={scopeMenu.x}
          y={scopeMenu.y}
          onClose={() => setScopeMenu(null)}
        />
      )}

      {/* Ducking: while the scope menu is open, hide the suggestions so the user
          can filter; they reappear (already refreshed for the new scope) on pick
          or dismiss. Portaled to <body> at a high z-index so nothing — the
          section tabs included — can paint over them. */}
      {open &&
        query.trim() !== "" &&
        anchor &&
        !scopeMenu &&
        createPortal(
          <div
            ref={overlayRef}
            className="v-search__results"
            role="listbox"
            style={{ position: "fixed", top: anchor.top, right: anchor.right, zIndex: 2000 }}
          >
            {loading && results.length === 0 ? (
            <div className="v-search__status">Searching…</div>
          ) : results.length === 0 ? (
            <div className="v-search__status">No results for “{query.trim()}”.</div>
          ) : (
            results.map((hit) => {
              const matchedAttachments = hit.attachmentFilenames.filter((name) =>
                nameMatchesTerms(name, terms),
              );
              return (
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
                    {hit.hasAttachment && matchedAttachments.length === 0 && (
                      <Icon name="paper-clip-small" className="v-search__attach" label="Has attachment" />
                    )}
                  </div>
                  {hit.snippet && (
                    <div className="v-search__snippet">{renderSnippet(hit.snippet)}</div>
                  )}
                  {matchedAttachments.length > 0 && (
                    <div className="v-search__attachments">
                      {matchedAttachments.map((name) => (
                        <span key={name} className="v-search__attach-name">
                          <Icon name="paper-clip-small" />
                          <span>{highlightTitle(name, terms)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="v-search__meta">{formatDate(hit.updatedAt)}</div>
                </button>
              );
            })
          )}
          </div>,
          document.body,
        )}
    </div>
  );
}
