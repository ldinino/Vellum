/**
 * App state: the notebook → section → page tree, current selection, and the
 * CRUD actions that mutate them. Backed entirely by Rust commands (see
 * src/data/api.ts). After a mutation we reload the affected list so on-screen
 * state always matches the database — the source of truth is SQLite, not React.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import * as api from "../data/api";
import { randomPaletteColor } from "../data/palette";
import { WELCOME_NOTEBOOK_NAME, buildWelcomePages } from "../data/welcome-content";
import { setIgnoredRules as applyIgnoredRules } from "../components/editor/grammar";
import type {
  Notebook,
  Page,
  PageSortDir,
  PageSortMode,
  PageTemplate,
  RecycleItem,
  RefineTemplate,
  Section,
} from "../data/types";

export interface TreeNotebook extends Notebook {
  expanded: boolean;
  /** null = sections not loaded yet (lazy on first expand). */
  sections: Section[] | null;
}

interface VellumState {
  notebooks: TreeNotebook[];
  pages: Page[];
  selectedNotebookId: string | null;
  selectedSectionId: string | null;
  selectedPageId: string | null;
  /** Query whose matches the open page should highlight (set when navigating
   * from a search result); empty when not arriving from search. */
  searchHighlight: string;
  /** Harper grammar check on/off (persisted in app.json). */
  grammarEnabled: boolean;
  /** Spell check on/off (Harper spelling, persisted in app.json). */
  spellcheckEnabled: boolean;
  /** Editor default font family + size (Settings → Editor; applied as CSS vars
   * on the document root, so unstyled page text uses them). */
  defaultFont: string;
  defaultFontSize: number;
  /** Words the user added to the Harper dictionary (app.json, spec Section 10). */
  customDictionary: string[];
  /** Grammar lint categories the user has ignored via "Ignore this rule". */
  ignoredGrammarRules: string[];
  /** Page template library (app.json). */
  pageTemplates: PageTemplate[];
  /** Refine settings + library (app.json; spec Sections 8, 9). */
  refineEnabled: boolean;
  refineAdherence: number;
  refineModelTier: string | null;
  refineTemplates: RefineTemplate[];
  /** Whether first-run setup has been completed (gates the setup screen). */
  firstRunComplete: boolean;
  /** Whether the first-launch "Welcome to Vellum" notebook has been seeded
   * (Phase 11); gates the one-time seeding effect. */
  welcomeSeeded: boolean;
  /** False until app.json has been read once, so the first-run screen doesn't
   * flash before we know whether setup is already done. */
  configLoaded: boolean;
  /** Soft-deleted items across all notebooks (Recycle Bin; spec Section 5.1). */
  recycleBin: RecycleItem[];
  /** Count of Recycle Bin entries, for the nav footer's empty/full icon. */
  recycleBinCount: number;
  /** Bumped when an attachment is restored from the bin so the open page's
   * attachment bar re-lists (it otherwise loads only once on mount). */
  attachmentsRefreshTick: number;
  error: string | null;
}

const initial: VellumState = {
  notebooks: [],
  pages: [],
  selectedNotebookId: null,
  selectedSectionId: null,
  selectedPageId: null,
  searchHighlight: "",
  grammarEnabled: true,
  spellcheckEnabled: true,
  defaultFont: "Segoe UI",
  defaultFontSize: 14,
  customDictionary: [],
  ignoredGrammarRules: [],
  pageTemplates: [],
  refineEnabled: false,
  refineAdherence: 0.5,
  refineModelTier: null,
  refineTemplates: [],
  firstRunComplete: false,
  welcomeSeeded: false,
  configLoaded: false,
  recycleBin: [],
  recycleBinCount: 0,
  attachmentsRefreshTick: 0,
  error: null,
};

export interface VellumActions {
  reload: () => Promise<void>;
  refreshPages: () => Promise<void>;
  clearError: () => void;
  /** Surface a message in the app-level banner (errors, Refine notices). */
  setError: (message: string) => void;
  toggleNotebook: (id: string) => Promise<void>;
  selectSection: (notebookId: string, sectionId: string) => Promise<void>;
  /** Select a notebook (e.g. from the collapsed rail): load its sections, then
   * keep the current section if it belongs to this notebook, else open its
   * first section (or none if it has no sections). */
  selectNotebook: (notebookId: string) => Promise<void>;
  selectPage: (pageId: string) => void;
  /** Navigate to a page anywhere (e.g. from a search result), expanding and
   * loading its notebook/section, and highlight `query` in it. */
  openPage: (
    notebookId: string,
    sectionId: string,
    pageId: string,
    query?: string,
  ) => Promise<void>;

  createNotebook: (name: string) => Promise<Notebook | null>;
  renameNotebook: (id: string, name: string) => Promise<void>;
  deleteNotebook: (id: string) => Promise<void>;
  setNotebookColor: (id: string, color: string | null) => Promise<void>;
  reorderNotebooks: (orderedIds: string[]) => Promise<void>;

  createSection: (notebookId: string, name: string) => Promise<Section | null>;
  renameSection: (notebookId: string, sectionId: string, name: string) => Promise<void>;
  updateSection: (
    notebookId: string,
    sectionId: string,
    name: string,
    color: string | null,
    pageTemplateId: string | null,
  ) => Promise<void>;
  deleteSection: (notebookId: string, sectionId: string) => Promise<void>;
  reorderSections: (notebookId: string, orderedIds: string[]) => Promise<void>;
  /** Set a section's page sort mode/direction, then re-list its pages. */
  setSectionSort: (
    notebookId: string,
    sectionId: string,
    mode: PageSortMode,
    dir: PageSortDir,
  ) => Promise<void>;

  setGrammarEnabled: (enabled: boolean) => Promise<void>;
  setSpellcheckEnabled: (enabled: boolean) => Promise<void>;
  /** Set the editor default font family (Settings → Editor; persisted + applied). */
  setDefaultFont: (font: string) => Promise<void>;
  /** Set the editor default font size in px (Settings → Editor; persisted + applied). */
  setDefaultFontSize: (size: number) => Promise<void>;
  /** Add a word to the Harper dictionary (persisted + synced to the engine). */
  addDictionaryWord: (word: string) => Promise<void>;
  /** Remove a word from the Harper dictionary. */
  removeDictionaryWord: (word: string) => Promise<void>;
  /** Ignore a grammar rule category persistently ("Ignore this rule"). */
  ignoreGrammarRule: (kind: string) => Promise<void>;
  /** Stop ignoring a grammar rule category (re-enables its underlines). */
  unignoreGrammarRule: (kind: string) => Promise<void>;
  /** Persist the page-template library to app.json. */
  savePageTemplates: (templates: PageTemplate[]) => Promise<void>;

  /** Toggle Refine: persists the setting and starts/stops Ollama (backend). */
  setRefineEnabled: (enabled: boolean) => Promise<void>;
  setRefineAdherence: (value: number) => Promise<void>;
  setRefineModelTier: (tier: string | null) => Promise<void>;
  /** Persist the Refine template library to app.json. */
  saveRefineTemplates: (templates: RefineTemplate[]) => Promise<void>;
  /** Mark first-run setup done (optionally also persisting the chosen tier). */
  completeFirstRun: (tier: string | null) => Promise<void>;

  createPage: (notebookId: string, sectionId: string, title?: string) => Promise<void>;
  setPageTitle: (notebookId: string, pageId: string, title: string) => Promise<void>;
  deletePage: (notebookId: string, pageId: string) => Promise<void>;
  duplicatePage: (notebookId: string, pageId: string) => Promise<void>;
  movePage: (notebookId: string, pageId: string, toSectionId: string) => Promise<void>;
  reorderPages: (notebookId: string, orderedIds: string[]) => Promise<void>;

  /** Remove an attachment from a page into the Recycle Bin (spec Section 5.1). */
  softDeleteAttachment: (notebookId: string, attachmentId: string) => Promise<void>;
  /** Refresh the Recycle Bin list + count from the backend. */
  loadRecycleBin: () => Promise<void>;
  /** Restore one Recycle Bin item to where it came from. */
  restoreItem: (item: RecycleItem) => Promise<void>;
  /** Permanently delete one Recycle Bin item. */
  purgeItem: (item: RecycleItem) => Promise<void>;
  /** Permanently delete everything in the Recycle Bin. */
  emptyRecycleBin: () => Promise<void>;
}

type VellumContextValue = VellumState & { actions: VellumActions };

const VellumContext = createContext<VellumContextValue | null>(null);

/** Machine-local last-open pointer (notebook/section/page) so a fresh launch
 * lands where you left off instead of the unreachable "nothing selected" state.
 * Kept in localStorage (not app.json) on purpose: it's per-machine session
 * state, and writing it to the OneDrive-synced app.json on every navigation
 * would cause sync churn. */
const LAST_OPEN_KEY = "vellum.lastOpen";

interface LastOpen {
  n: string | null;
  s: string | null;
  p: string | null;
}

function readLastOpen(): LastOpen | null {
  try {
    const raw = localStorage.getItem(LAST_OPEN_KEY);
    return raw ? (JSON.parse(raw) as LastOpen) : null;
  } catch {
    return null;
  }
}

/** Per-section "last open page" memory (sectionId → pageId) so re-opening a
 * section returns you to the page you were on instead of nothing. Same
 * per-machine/localStorage rationale as LAST_OPEN_KEY above. Stale entries for
 * deleted sections are harmless — they're validated against the live page list
 * on read and never queried for a section that no longer exists. */
const LAST_PAGE_KEY = "vellum.lastPagePerSection";

function readLastPageMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readLastPage(sectionId: string): string | null {
  return readLastPageMap()[sectionId] ?? null;
}

function writeLastPage(sectionId: string, pageId: string) {
  try {
    const map = readLastPageMap();
    if (map[sectionId] === pageId) return;
    map[sectionId] = pageId;
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

/** Apply the configured editor default font + size as CSS custom properties on
 * the document root (consumed by `.v-prose`; see editor.css). Called on config
 * load and whenever the setting changes so unstyled page text updates live. */
function applyEditorFont(font: string, size: number) {
  const root = document.documentElement;
  if (font) root.style.setProperty("--editor-font", `"${font}"`);
  else root.style.removeProperty("--editor-font");
  if (size > 0) root.style.setProperty("--editor-font-size", `${size}px`);
  else root.style.removeProperty("--editor-font-size");
}

export function VellumProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VellumState>(initial);
  // Mirror for reading current values inside async actions without stale closures.
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);

  const fail = useCallback((e: unknown) => {
    const message = typeof e === "string" ? e : String(e);
    setState((s) => ({ ...s, error: message }));
    // Mirror user-visible failures into the diagnostic log (best-effort).
    api.logFrontendEvent("error", "ui", message).catch(() => {});
  }, []);

  const reloadSections = useCallback(
    async (notebookId: string) => {
      try {
        const sections = await api.listSections(notebookId);
        setState((s) => ({
          ...s,
          notebooks: s.notebooks.map((nb) =>
            nb.id === notebookId ? { ...nb, sections } : nb,
          ),
        }));
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  const reloadPages = useCallback(
    async (notebookId: string, sectionId: string): Promise<Page[]> => {
      try {
        const pages = await api.listPages(notebookId, sectionId);
        setState((s) => ({ ...s, pages }));
        return pages;
      } catch (e) {
        fail(e);
        return [];
      }
    },
    [fail],
  );

  const reload = useCallback(async () => {
    try {
      const nbs = await api.listNotebooks();
      setState((s) => ({
        ...s,
        notebooks: nbs.map((nb) => {
          const prev = s.notebooks.find((p) => p.id === nb.id);
          return {
            ...nb,
            expanded: prev?.expanded ?? false,
            sections: prev?.sections ?? null,
          };
        }),
      }));
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  // First-launch welcome content (spec Phase 11). Persist the "seeded" flag so
  // the welcome notebook is created exactly once, ever — even if the user later
  // deletes it. Optimistic state update, then write app.json (preserving the
  // rest of settings).
  const markWelcomeSeeded = useCallback(async () => {
    setState((s) => ({ ...s, welcomeSeeded: true }));
    try {
      const cfg = await api.getAppConfig();
      await api.saveAppConfig({
        ...cfg,
        settings: { ...cfg.settings, welcomeSeeded: true },
      });
    } catch (e) {
      console.error("persist welcomeSeeded failed", e);
    }
  }, []);

  // Create the "Welcome to Vellum" notebook: one section per topic, each with a
  // single page whose authored HTML is converted to editor JSON. Builds the tree
  // from fresh fetches (not reload()'s timing) and lands the user on the first
  // page. Sets the seeded flag *after* the content is written, so a crash
  // mid-seed simply retries next launch (a rare, tolerable double-seed).
  const seedWelcomeNotebook = useCallback(async () => {
    const created = await api.createNotebook(WELCOME_NOTEBOOK_NAME);
    await api.setNotebookColor(created.id, randomPaletteColor());

    let firstSectionId: string | null = null;
    let firstPageId: string | null = null;
    for (const wp of buildWelcomePages()) {
      const section = await api.createSection(created.id, wp.sectionName);
      await api.updateSection(
        created.id,
        section.id,
        section.name,
        randomPaletteColor(),
        section.pageTemplateId,
      );
      const page = await api.createPage(created.id, section.id, wp.pageTitle);
      await api.savePageSnapshot(created.id, page.id, wp.contentJson, wp.preview);
      if (!firstSectionId) {
        firstSectionId = section.id;
        firstPageId = page.id;
      }
    }

    await markWelcomeSeeded();

    // Build the tree from fresh fetches, expand the welcome notebook, and open
    // its first page so launch never lands on a blank state.
    const nbs = await api.listNotebooks();
    const sections = await api.listSections(created.id);
    const pages = firstSectionId ? await api.listPages(created.id, firstSectionId) : [];
    setState((s) => ({
      ...s,
      notebooks: nbs.map((nb) => {
        const prev = s.notebooks.find((p) => p.id === nb.id);
        return {
          ...nb,
          expanded: nb.id === created.id ? true : prev?.expanded ?? false,
          sections: nb.id === created.id ? sections : prev?.sections ?? null,
        };
      }),
      selectedNotebookId: created.id,
      selectedSectionId: firstSectionId,
      selectedPageId: firstPageId,
      pages,
    }));
  }, [markWelcomeSeeded]);

  // Recycle Bin (spec Section 5.1): the list + count of soft-deleted items
  // across all notebooks. Loaded on startup for the nav footer's empty/full
  // icon and refreshed whenever the bin changes (restore / purge / empty).
  const loadRecycleBin = useCallback(async () => {
    try {
      const items = await api.listRecycleBin();
      setState((s) => ({ ...s, recycleBin: items, recycleBinCount: items.length }));
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Reflect any existing Recycle Bin contents in the nav footer icon on launch.
  useEffect(() => {
    loadRecycleBin();
  }, [loadRecycleBin]);

  // Rebuild the master search index once on startup so global search is complete
  // and self-heals any drift (deletes/edits made while the app was closed).
  useEffect(() => {
    api.reindexAll().catch((e) => console.error("reindex failed", e));
  }, []);

  // Load persisted app config (grammar, templates, Refine) once on startup.
  useEffect(() => {
    api
      .getAppConfig()
      .then((cfg) => {
        // Apply the persisted ignored rules to the live underline filter before
        // the first lint runs (spec Section 10).
        applyIgnoredRules(cfg.settings.ignoredGrammarRules ?? []);
        const defaultFont = cfg.settings.defaultFont || "Segoe UI";
        const defaultFontSize = cfg.settings.defaultFontSize || 14;
        applyEditorFont(defaultFont, defaultFontSize);
        setState((s) => ({
          ...s,
          grammarEnabled: cfg.settings.grammarEnabled,
          spellcheckEnabled: cfg.settings.spellcheckEnabled,
          defaultFont,
          defaultFontSize,
          customDictionary: cfg.settings.customDictionary ?? [],
          ignoredGrammarRules: cfg.settings.ignoredGrammarRules ?? [],
          pageTemplates: cfg.pageTemplates ?? [],
          refineEnabled: cfg.settings.refineEnabled,
          refineAdherence: cfg.settings.refineAdherence,
          refineModelTier: cfg.settings.refineModelTier,
          refineTemplates: cfg.refineTemplates ?? [],
          firstRunComplete: cfg.settings.firstRunComplete,
          welcomeSeeded: cfg.settings.welcomeSeeded,
          configLoaded: true,
        }));
      })
      .catch((e) => {
        console.error("load app config failed", e);
        // Don't trap the app behind a never-loading first-run gate.
        setState((s) => ({ ...s, configLoaded: true }));
      });
  }, []);

  // First-launch welcome content: seed the "Welcome to Vellum" notebook once,
  // ever. The persisted `welcomeSeeded` flag is the authoritative gate; we also
  // require the registry to be empty so an install that already has notebooks
  // never gets a welcome notebook injected (it just records the flag). Ref-
  // guarded against React StrictMode's double-invoke.
  const welcomeSeedStarted = useRef(false);
  useEffect(() => {
    if (!state.configLoaded || state.welcomeSeeded || welcomeSeedStarted.current) return;
    welcomeSeedStarted.current = true;
    (async () => {
      try {
        const nbs = await api.listNotebooks();
        if (nbs.length === 0) await seedWelcomeNotebook();
        else await markWelcomeSeeded();
      } catch (e) {
        console.error("welcome notebook seed failed", e);
        welcomeSeedStarted.current = false; // flag stays false → retry next launch
      }
    })();
  }, [state.configLoaded, state.welcomeSeeded, seedWelcomeNotebook, markWelcomeSeeded]);

  // Restore the last-open notebook → section → page once on startup (or fall
  // back to the first of each), so launch never lands on the unreachable
  // "nothing selected" state. Each saved id is validated against what still
  // exists; a deleted target degrades to the first sibling. `restoreReady`
  // gates the persistence effect below so it can't clobber the saved pointer
  // with the initial nulls before this runs.
  const restoreReady = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = readLastOpen();
      try {
        const nbs = await api.listNotebooks();
        const nbId =
          saved?.n && nbs.some((n) => n.id === saved.n) ? saved.n : nbs[0]?.id ?? null;
        if (!nbId) return;

        const sections = await api.listSections(nbId);
        const secId =
          saved?.s && sections.some((sec) => sec.id === saved.s)
            ? saved.s
            : sections[0]?.id ?? null;

        let pages: Page[] = [];
        let pageId: string | null = null;
        if (secId) {
          pages = await api.listPages(nbId, secId);
          pageId =
            saved?.p && pages.some((pg) => pg.id === saved.p)
              ? saved.p
              : pages[0]?.id ?? null;
        }
        if (cancelled) return;

        // Build the notebook tree from this fetch (don't depend on reload()'s
        // timing): mark the restored notebook expanded with its sections, and
        // preserve any expand/sections state reload() may have already set.
        setState((s) => ({
          ...s,
          notebooks: nbs.map((nb) => {
            const prev = s.notebooks.find((p) => p.id === nb.id);
            return {
              ...nb,
              expanded: nb.id === nbId ? true : prev?.expanded ?? false,
              sections: nb.id === nbId ? sections : prev?.sections ?? null,
            };
          }),
          selectedNotebookId: nbId,
          selectedSectionId: secId,
          selectedPageId: pageId,
          pages,
        }));
      } catch (e) {
        console.error("restore last-open failed", e);
      } finally {
        if (!cancelled) restoreReady.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the current selection so the next launch can restore it. Gated on
  // restoreReady so the initial null selection never overwrites the saved value
  // before restore has had a chance to apply it.
  useEffect(() => {
    if (!restoreReady.current) return;
    try {
      if (state.selectedNotebookId) {
        localStorage.setItem(
          LAST_OPEN_KEY,
          JSON.stringify({
            n: state.selectedNotebookId,
            s: state.selectedSectionId,
            p: state.selectedPageId,
          }),
        );
      } else {
        // Last notebook was deleted: drop the stale pointer.
        localStorage.removeItem(LAST_OPEN_KEY);
      }
      // Remember the current page per section so re-opening it returns here.
      if (state.selectedSectionId && state.selectedPageId) {
        writeLastPage(state.selectedSectionId, state.selectedPageId);
      }
    } catch {
      // localStorage unavailable (e.g. some embedded contexts) — non-fatal.
    }
  }, [state.selectedNotebookId, state.selectedSectionId, state.selectedPageId]);

  const toggleNotebook = useCallback(
    async (id: string) => {
      const nb = ref.current.notebooks.find((n) => n.id === id);
      const willExpand = !nb?.expanded;
      setState((s) => ({
        ...s,
        notebooks: s.notebooks.map((n) =>
          n.id === id ? { ...n, expanded: willExpand } : n,
        ),
      }));
      if (willExpand && nb?.sections == null) await reloadSections(id);
    },
    [reloadSections],
  );

  const selectSection = useCallback(
    async (notebookId: string, sectionId: string) => {
      setState((s) => ({
        ...s,
        selectedNotebookId: notebookId,
        selectedSectionId: sectionId,
        selectedPageId: null,
        searchHighlight: "",
        pages: [],
      }));
      const pages = await reloadPages(notebookId, sectionId);
      // Jump to the last page viewed in this section (if it still exists),
      // else the first page, so opening a section never lands on a blank state.
      const saved = readLastPage(sectionId);
      const pageId =
        saved && pages.some((p) => p.id === saved) ? saved : pages[0]?.id ?? null;
      // Guard against a fast section switch: only apply if still the active section.
      setState((s) =>
        s.selectedSectionId === sectionId ? { ...s, selectedPageId: pageId } : s,
      );
    },
    [reloadPages],
  );

  const selectNotebook = useCallback(
    async (notebookId: string) => {
      const nb = ref.current.notebooks.find((n) => n.id === notebookId);
      let sections = nb?.sections ?? null;
      if (sections == null) {
        try {
          sections = await api.listSections(notebookId);
        } catch (e) {
          fail(e);
          sections = [];
        }
        const loaded = sections;
        setState((s) => ({
          ...s,
          notebooks: s.notebooks.map((n) =>
            n.id === notebookId ? { ...n, sections: loaded } : n,
          ),
        }));
      }
      const cur = ref.current.selectedSectionId;
      const keep = cur && sections.some((sec) => sec.id === cur) ? cur : null;
      const target = keep ?? sections[0]?.id ?? null;
      if (target) {
        await selectSection(notebookId, target);
      } else {
        setState((s) => ({
          ...s,
          selectedNotebookId: notebookId,
          selectedSectionId: null,
          selectedPageId: null,
          pages: [],
        }));
      }
    },
    [fail, selectSection],
  );

  const selectPage = useCallback((pageId: string) => {
    setState((s) => ({ ...s, selectedPageId: pageId, searchHighlight: "" }));
  }, []);

  const openPage = useCallback(
    async (notebookId: string, sectionId: string, pageId: string, query = "") => {
      // Make sure the target notebook is expanded with its sections loaded.
      const nb = ref.current.notebooks.find((n) => n.id === notebookId);
      if (nb?.sections == null) await reloadSections(notebookId);
      setState((s) => ({
        ...s,
        notebooks: s.notebooks.map((n) =>
          n.id === notebookId ? { ...n, expanded: true } : n,
        ),
      }));
      // Select the section (loads its pages), then the page, then the highlight.
      setState((s) => ({
        ...s,
        selectedNotebookId: notebookId,
        selectedSectionId: sectionId,
        selectedPageId: null,
        searchHighlight: "",
        pages: [],
      }));
      await reloadPages(notebookId, sectionId);
      setState((s) => ({ ...s, selectedPageId: pageId, searchHighlight: query }));
    },
    [reloadSections, reloadPages],
  );

  // After a section mutation, reload that notebook's sections (if loaded).
  const afterSectionChange = useCallback(
    async (notebookId: string) => {
      await reloadSections(notebookId);
    },
    [reloadSections],
  );

  // After a page mutation in the selected section, reload its pages.
  const refreshSelectedPages = useCallback(async () => {
    const { selectedNotebookId, selectedSectionId } = ref.current;
    if (selectedNotebookId && selectedSectionId) {
      await reloadPages(selectedNotebookId, selectedSectionId);
    }
  }, [reloadPages]);

  // Create a section (with a random color + one blank page so it's never empty)
  // in a notebook, returning it with its color. Pure DB writes — the caller is
  // responsible for any reload. Shared by createSection and createNotebook so the
  // "every section starts with a page" invariant lives in exactly one place.
  const createSectionWithPage = useCallback(
    async (notebookId: string, name: string): Promise<Section> => {
      const section = await api.createSection(notebookId, name);
      const color = randomPaletteColor();
      await api.updateSection(
        notebookId,
        section.id,
        section.name,
        color,
        section.pageTemplateId,
      );
      await api.createPage(notebookId, section.id, "");
      return { ...section, color };
    },
    [],
  );

  const actions: VellumActions = {
    reload,
    refreshPages: refreshSelectedPages,
    clearError: () => setState((s) => ({ ...s, error: null })),
    setError: (message: string) => setState((s) => ({ ...s, error: message })),
    toggleNotebook,
    selectSection,
    selectNotebook,
    selectPage,
    openPage,

    setGrammarEnabled: async (enabled) => {
      // Optimistic toggle, then persist into app.json (preserving other fields).
      setState((s) => ({ ...s, grammarEnabled: enabled }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({
          ...cfg,
          settings: { ...cfg.settings, grammarEnabled: enabled },
        });
      } catch (e) {
        fail(e);
      }
    },
    setSpellcheckEnabled: async (enabled) => {
      // Optimistic toggle, then persist into app.json (preserving other fields).
      setState((s) => ({ ...s, spellcheckEnabled: enabled }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({
          ...cfg,
          settings: { ...cfg.settings, spellcheckEnabled: enabled },
        });
      } catch (e) {
        fail(e);
      }
    },
    setDefaultFont: async (font) => {
      // Optimistic state + live CSS-var apply, then persist into app.json.
      setState((s) => ({ ...s, defaultFont: font }));
      applyEditorFont(font, ref.current.defaultFontSize);
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({ ...cfg, settings: { ...cfg.settings, defaultFont: font } });
      } catch (e) {
        fail(e);
      }
    },
    setDefaultFontSize: async (size) => {
      setState((s) => ({ ...s, defaultFontSize: size }));
      applyEditorFont(ref.current.defaultFont, size);
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({ ...cfg, settings: { ...cfg.settings, defaultFontSize: size } });
      } catch (e) {
        fail(e);
      }
    },
    addDictionaryWord: async (word) => {
      // Config is the source of truth: read-modify-write it, then sync the engine
      // (so underlines refresh) and mirror into state. Dedup case-insensitively
      // since Harper accepts any capitalization of a known word.
      const w = word.trim();
      if (!w) return;
      try {
        const cfg = await api.getAppConfig();
        const current = cfg.settings.customDictionary ?? [];
        if (current.some((x) => x.toLowerCase() === w.toLowerCase())) {
          setState((s) => ({ ...s, customDictionary: current }));
          return;
        }
        const next = [...current, w];
        await api.saveAppConfig({ ...cfg, settings: { ...cfg.settings, customDictionary: next } });
        await api.setDictionaryWords(next);
        setState((s) => ({ ...s, customDictionary: next }));
      } catch (e) {
        fail(e);
      }
    },
    removeDictionaryWord: async (word) => {
      try {
        const cfg = await api.getAppConfig();
        const next = (cfg.settings.customDictionary ?? []).filter((x) => x !== word);
        await api.saveAppConfig({ ...cfg, settings: { ...cfg.settings, customDictionary: next } });
        await api.setDictionaryWords(next);
        setState((s) => ({ ...s, customDictionary: next }));
      } catch (e) {
        fail(e);
      }
    },
    ignoreGrammarRule: async (kind) => {
      try {
        const cfg = await api.getAppConfig();
        const current = cfg.settings.ignoredGrammarRules ?? [];
        const next = current.includes(kind) ? current : [...current, kind];
        if (next !== current) {
          await api.saveAppConfig({
            ...cfg,
            settings: { ...cfg.settings, ignoredGrammarRules: next },
          });
        }
        applyIgnoredRules(next);
        setState((s) => ({ ...s, ignoredGrammarRules: next }));
      } catch (e) {
        fail(e);
      }
    },
    unignoreGrammarRule: async (kind) => {
      try {
        const cfg = await api.getAppConfig();
        const next = (cfg.settings.ignoredGrammarRules ?? []).filter((k) => k !== kind);
        await api.saveAppConfig({
          ...cfg,
          settings: { ...cfg.settings, ignoredGrammarRules: next },
        });
        applyIgnoredRules(next);
        setState((s) => ({ ...s, ignoredGrammarRules: next }));
      } catch (e) {
        fail(e);
      }
    },
    savePageTemplates: async (templates) => {
      // Optimistic, then persist into app.json (preserving other fields).
      setState((s) => ({ ...s, pageTemplates: templates }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({ ...cfg, pageTemplates: templates });
      } catch (e) {
        fail(e);
      }
    },

    setRefineEnabled: async (enabled) => {
      // refine_enable persists the setting AND starts/stops Ollama on the
      // backend, so we don't write app.json here ourselves.
      setState((s) => ({ ...s, refineEnabled: enabled }));
      try {
        await api.refineEnable(enabled);
      } catch (e) {
        setState((s) => ({ ...s, refineEnabled: !enabled }));
        fail(e);
      }
    },
    setRefineAdherence: async (value) => {
      setState((s) => ({ ...s, refineAdherence: value }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({
          ...cfg,
          settings: { ...cfg.settings, refineAdherence: value },
        });
      } catch (e) {
        fail(e);
      }
    },
    setRefineModelTier: async (tier) => {
      setState((s) => ({ ...s, refineModelTier: tier }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({
          ...cfg,
          settings: { ...cfg.settings, refineModelTier: tier },
        });
      } catch (e) {
        fail(e);
      }
    },
    saveRefineTemplates: async (templates) => {
      setState((s) => ({ ...s, refineTemplates: templates }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({ ...cfg, refineTemplates: templates });
      } catch (e) {
        fail(e);
      }
    },
    completeFirstRun: async (tier) => {
      setState((s) => ({
        ...s,
        firstRunComplete: true,
        refineModelTier: tier ?? s.refineModelTier,
      }));
      try {
        const cfg = await api.getAppConfig();
        await api.saveAppConfig({
          ...cfg,
          settings: {
            ...cfg.settings,
            firstRunComplete: true,
            refineModelTier: tier ?? cfg.settings.refineModelTier,
          },
        });
      } catch (e) {
        fail(e);
      }
    },

    createNotebook: async (name) => {
      try {
        const nb = await api.createNotebook(name);
        const color = randomPaletteColor();
        await api.setNotebookColor(nb.id, color);
        // A new notebook starts with one section (which itself starts with a
        // blank page) so it's never empty.
        await createSectionWithPage(nb.id, "New Section");
        await reload();
        return { ...nb, color };
      } catch (e) {
        fail(e);
        return null;
      }
    },
    renameNotebook: async (id, name) => {
      try {
        await api.renameNotebook(id, name);
        await reload();
      } catch (e) {
        fail(e);
      }
    },
    deleteNotebook: async (id) => {
      try {
        // Capture the neighbor (prefer the next notebook, else the previous one)
        // before deleting so deleting the notebook you're inside navigates there
        // instead of dropping to a blank "no notebook" state.
        const wasSelected = ref.current.selectedNotebookId === id;
        const notebooks = ref.current.notebooks;
        const idx = notebooks.findIndex((n) => n.id === id);
        const neighbor =
          idx >= 0 ? notebooks[idx + 1] ?? notebooks[idx - 1] ?? null : null;

        await api.softDeleteNotebook(id);
        setState((s) => ({ ...s, recycleBinCount: s.recycleBinCount + 1 }));
        await reload();

        if (wasSelected) {
          if (neighbor) {
            // Expand the neighbor in the tree and open its first section/page.
            setState((s) => ({
              ...s,
              notebooks: s.notebooks.map((n) =>
                n.id === neighbor.id ? { ...n, expanded: true } : n,
              ),
            }));
            await selectNotebook(neighbor.id);
          } else {
            // The last notebook is gone — nothing to navigate to.
            setState((s) => ({
              ...s,
              selectedNotebookId: null,
              selectedSectionId: null,
              selectedPageId: null,
              pages: [],
            }));
          }
        }
      } catch (e) {
        fail(e);
      }
    },
    setNotebookColor: async (id, color) => {
      try {
        await api.setNotebookColor(id, color);
        await reload();
      } catch (e) {
        fail(e);
      }
    },
    reorderNotebooks: async (orderedIds) => {
      try {
        await api.reorderNotebooks(orderedIds);
        await reload();
      } catch (e) {
        fail(e);
      }
    },

    createSection: async (notebookId, name) => {
      try {
        const section = await createSectionWithPage(notebookId, name);
        await afterSectionChange(notebookId);
        return section;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    renameSection: async (notebookId, sectionId, name) => {
      try {
        await api.renameSection(notebookId, sectionId, name);
        await afterSectionChange(notebookId);
      } catch (e) {
        fail(e);
      }
    },
    updateSection: async (notebookId, sectionId, name, color, pageTemplateId) => {
      try {
        await api.updateSection(notebookId, sectionId, name, color, pageTemplateId);
        await afterSectionChange(notebookId);
      } catch (e) {
        fail(e);
      }
    },
    deleteSection: async (notebookId, sectionId) => {
      try {
        // Capture the neighbor (prefer the next section, else the previous one)
        // before deleting so a deleted-while-selected section navigates there
        // instead of leaving nothing selected.
        const wasSelected = ref.current.selectedSectionId === sectionId;
        const sections =
          ref.current.notebooks.find((n) => n.id === notebookId)?.sections ?? [];
        const idx = sections.findIndex((sec) => sec.id === sectionId);
        const neighbor =
          idx >= 0 ? sections[idx + 1] ?? sections[idx - 1] ?? null : null;

        await api.softDeleteSection(notebookId, sectionId);
        setState((s) => ({ ...s, recycleBinCount: s.recycleBinCount + 1 }));
        await afterSectionChange(notebookId);

        if (wasSelected) {
          if (neighbor) {
            await selectSection(notebookId, neighbor.id);
          } else {
            // Last section in the notebook is gone — clear the selection.
            setState((s) => ({
              ...s,
              selectedSectionId: null,
              selectedPageId: null,
              pages: [],
            }));
          }
        }
      } catch (e) {
        fail(e);
      }
    },
    reorderSections: async (notebookId, orderedIds) => {
      try {
        await api.reorderSections(notebookId, orderedIds);
        await afterSectionChange(notebookId);
      } catch (e) {
        fail(e);
      }
    },
    setSectionSort: async (notebookId, sectionId, mode, dir) => {
      try {
        await api.setSectionSort(notebookId, sectionId, mode, dir);
        // Refresh the section list (so the control reflects the new mode/dir)
        // and re-list pages in the new order.
        await afterSectionChange(notebookId);
        await refreshSelectedPages();
      } catch (e) {
        fail(e);
      }
    },

    createPage: async (notebookId, sectionId, title = "") => {
      try {
        const page = await api.createPage(notebookId, sectionId, title);
        await refreshSelectedPages();
        if (ref.current.selectedSectionId === sectionId) selectPage(page.id);
      } catch (e) {
        fail(e);
      }
    },
    setPageTitle: async (notebookId, pageId, title) => {
      try {
        await api.setPageTitle(notebookId, pageId, title);
        await refreshSelectedPages();
      } catch (e) {
        fail(e);
      }
    },
    deletePage: async (notebookId, pageId) => {
      try {
        // If we're deleting the open page, land on the adjacent one (the next
        // page, else the previous) computed from the CURRENT in-memory order so
        // a prior reorder is respected — instead of dropping to a blank view.
        const wasSelected = ref.current.selectedPageId === pageId;
        const cur = ref.current.pages;
        const idx = cur.findIndex((p) => p.id === pageId);
        const neighborId =
          idx >= 0 ? (cur[idx + 1] ?? cur[idx - 1])?.id ?? null : null;

        await api.softDeletePage(notebookId, pageId);
        setState((s) => ({ ...s, recycleBinCount: s.recycleBinCount + 1 }));
        await refreshSelectedPages();
        if (wasSelected) {
          setState((s) => ({ ...s, selectedPageId: neighborId }));
        }
      } catch (e) {
        fail(e);
      }
    },
    duplicatePage: async (notebookId, pageId) => {
      try {
        const dup = await api.duplicatePage(notebookId, pageId);
        await refreshSelectedPages();
        selectPage(dup.id);
      } catch (e) {
        fail(e);
      }
    },
    movePage: async (notebookId, pageId, toSectionId) => {
      try {
        // Remember the page directly above the one being moved (fall back to the
        // one below if it was at the top) so moving the open page lands there
        // instead of a blank view.
        const wasSelected = ref.current.selectedPageId === pageId;
        const cur = ref.current.pages;
        const idx = cur.findIndex((p) => p.id === pageId);
        const neighborId =
          idx >= 0 ? (cur[idx - 1] ?? cur[idx + 1])?.id ?? null : null;

        await api.movePage(notebookId, pageId, toSectionId);
        await refreshSelectedPages();
        if (wasSelected) {
          setState((s) => ({ ...s, selectedPageId: neighborId }));
        }
      } catch (e) {
        fail(e);
      }
    },
    reorderPages: async (notebookId, orderedIds) => {
      try {
        await api.reorderPages(notebookId, orderedIds);
        await refreshSelectedPages();
      } catch (e) {
        fail(e);
      }
    },

    loadRecycleBin,
    softDeleteAttachment: async (notebookId, attachmentId) => {
      // Let errors propagate so the caller (PageEditor) keeps the chip on
      // failure; on success bump the footer count (reconciled by loadRecycleBin).
      await api.softDeleteAttachment(notebookId, attachmentId);
      setState((s) => ({ ...s, recycleBinCount: s.recycleBinCount + 1 }));
    },
    restoreItem: async (item) => {
      try {
        const hadSections = !!ref.current.notebooks.find(
          (n) => n.id === item.notebookId,
        )?.sections;
        await api.restoreItem(item.kind, item.notebookId, item.id);
        // Bring the restored item back into view: notebooks re-list, and the
        // owning notebook's sections/pages refresh if they're on screen.
        await reload();
        if (hadSections) await reloadSections(item.notebookId);
        await refreshSelectedPages();
        // A restored attachment may belong to the page open right now; nudge its
        // editor to re-list attachments (the bar loads only once on mount).
        if (item.kind === "attachment") {
          setState((s) => ({
            ...s,
            attachmentsRefreshTick: s.attachmentsRefreshTick + 1,
          }));
        }
        await loadRecycleBin();
      } catch (e) {
        fail(e);
      }
    },
    purgeItem: async (item) => {
      try {
        await api.purgeItem(item.kind, item.notebookId, item.id);
        await loadRecycleBin();
      } catch (e) {
        fail(e);
      }
    },
    emptyRecycleBin: async () => {
      try {
        await api.emptyRecycleBin();
        await loadRecycleBin();
      } catch (e) {
        fail(e);
      }
    },
  };

  return (
    <VellumContext.Provider value={{ ...state, actions }}>
      {children}
    </VellumContext.Provider>
  );
}

export function useVellum(): VellumContextValue {
  const ctx = useContext(VellumContext);
  if (!ctx) throw new Error("useVellum must be used within VellumProvider");
  return ctx;
}
