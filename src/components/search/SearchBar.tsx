/**
 * Always-visible search bar (spec Section 11): a query field with a scope
 * dropdown, a collapsible filter panel, and a results overlay. Results update
 * as the user types (200ms debounce). Clicking a result opens its page and
 * highlights the matches there.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import type { SearchFilters, SearchHit, Section } from "../../data/types";
import "./SearchBar.css";

const HL_OPEN = "";
const HL_CLOSE = "";

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
  // Capturing split: matched terms land on the odd indices, so we don't need a
  // (stateful, global-`lastIndex`-prone) re.test to tell parts apart.
  const re = new RegExp(`(${escaped.join("|")})`, "i");
  // Keep the original indices so the odd/even parity stays valid; drop empties
  // by rendering null (React skips them) rather than filtering the array.
  return text.split(re).map((part, i) => {
    if (part === "") return null;
    return i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>;
  });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function SearchBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { notebooks, actions } = useVellum();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(""); // "" = all notebooks
  const [filterOpen, setFilterOpen] = useState(false);
  const [multiIds, setMultiIds] = useState<string[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [sectionOptions, setSectionOptions] = useState<Section[]>([]);
  const [dateField, setDateField] = useState<"modified" | "created">("modified");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);

  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const multiKey = multiIds.join(",");

  // Load sections when scoped to a single notebook (for the Section filter).
  useEffect(() => {
    setSectionId("");
    if (!scope) {
      setSectionOptions([]);
      return;
    }
    let active = true;
    api
      .listSections(scope)
      .then((s) => active && setSectionOptions(s))
      .catch(() => active && setSectionOptions([]));
    return () => {
      active = false;
    };
  }, [scope]);

  // Debounced search whenever the query or any filter changes.
  useEffect(() => {
    if (query.trim() === "") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(() => {
      const effectiveNotebookIds = scope
        ? [scope]
        : multiIds.length > 0
          ? multiIds
          : undefined;
      const filters: SearchFilters = {
        notebookIds: effectiveNotebookIds,
        sectionId: scope && sectionId ? sectionId : undefined,
        hasAttachment: hasAttachment ? true : undefined,
      };
      if (dateFrom || dateTo) {
        filters.dateField = dateField;
        if (dateFrom) filters.dateFrom = `${dateFrom}T00:00:00Z`;
        if (dateTo) filters.dateTo = `${dateTo}T23:59:59Z`;
      }
      api
        .search(query, filters)
        .then((hits) => setResults(hits))
        .catch((e) => console.error("search failed", e))
        .finally(() => setLoading(false));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, scope, multiKey, sectionId, dateField, dateFrom, dateTo, hasAttachment]);

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

  const filterCount =
    (scope ? 0 : multiIds.length) +
    (scope && sectionId ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (hasAttachment ? 1 : 0);

  return (
    <div className="v-search" ref={containerRef}>
      <div className="v-search__bar">
        <div className="v-search__field">
          <Icon name="magnifier" className="v-search__field-icon" />
          <input
            type="text"
            className="v-search__input"
            placeholder="Search all notebooks…"
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
        </div>

        <select
          className="v-search__scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="Search scope"
          title="Search scope"
        >
          <option value="">All Notebooks</option>
          {notebooks.map((nb) => (
            <option key={nb.id} value={nb.id}>
              {nb.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`v-search__filter-toggle${filterOpen ? " is-open" : ""}`}
          onClick={() => setFilterOpen((v) => !v)}
          aria-expanded={filterOpen}
        >
          Filters{filterCount > 0 ? ` (${filterCount})` : ""}
        </button>

        <button
          type="button"
          className="v-search__settings"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <Icon name="gear" />
        </button>
      </div>

      {filterOpen && (
        <div className="v-search__filters">
          {!scope && (
            <div className="v-search__filter-group">
              <span className="v-search__filter-label">Notebooks</span>
              <div className="v-search__checks">
                {notebooks.map((nb) => (
                  <label key={nb.id} className="v-search__check">
                    <input
                      type="checkbox"
                      checked={multiIds.includes(nb.id)}
                      onChange={(e) =>
                        setMultiIds((ids) =>
                          e.target.checked
                            ? [...ids, nb.id]
                            : ids.filter((x) => x !== nb.id),
                        )
                      }
                    />
                    {nb.name}
                  </label>
                ))}
                {notebooks.length === 0 && (
                  <span className="v-search__hint">No notebooks yet.</span>
                )}
              </div>
            </div>
          )}

          {scope && (
            <div className="v-search__filter-group">
              <span className="v-search__filter-label">Section</span>
              <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Any section</option>
                {sectionOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="v-search__filter-group">
            <span className="v-search__filter-label">Date</span>
            <select
              value={dateField}
              onChange={(e) => setDateField(e.target.value as "modified" | "created")}
              aria-label="Date field"
            >
              <option value="modified">Modified</option>
              <option value="created">Created</option>
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="From date"
            />
            <span className="v-search__dash">–</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="To date"
            />
          </div>

          <div className="v-search__filter-group">
            <label className="v-search__check">
              <input
                type="checkbox"
                checked={hasAttachment}
                onChange={(e) => setHasAttachment(e.target.checked)}
              />
              Has attachment
            </label>
          </div>
        </div>
      )}

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
