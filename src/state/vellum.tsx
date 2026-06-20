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
import type {
  Notebook,
  Page,
  PageTemplate,
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
  /** Page template library (app.json). */
  pageTemplates: PageTemplate[];
  /** Refine settings + library (app.json; spec Sections 8, 9). */
  refineEnabled: boolean;
  refineAdherence: number;
  refineModelTier: string | null;
  refineTemplates: RefineTemplate[];
  /** Whether first-run setup has been completed (gates the setup screen). */
  firstRunComplete: boolean;
  /** False until app.json has been read once, so the first-run screen doesn't
   * flash before we know whether setup is already done. */
  configLoaded: boolean;
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
  pageTemplates: [],
  refineEnabled: false,
  refineAdherence: 0.5,
  refineModelTier: null,
  refineTemplates: [],
  firstRunComplete: false,
  configLoaded: false,
  error: null,
};

export interface VellumActions {
  reload: () => Promise<void>;
  refreshPages: () => Promise<void>;
  clearError: () => void;
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

  setGrammarEnabled: (enabled: boolean) => Promise<void>;
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

export function VellumProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VellumState>(initial);
  // Mirror for reading current values inside async actions without stale closures.
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);

  const fail = useCallback((e: unknown) => {
    setState((s) => ({ ...s, error: typeof e === "string" ? e : String(e) }));
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
    async (notebookId: string, sectionId: string) => {
      try {
        const pages = await api.listPages(notebookId, sectionId);
        setState((s) => ({ ...s, pages }));
      } catch (e) {
        fail(e);
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

  useEffect(() => {
    reload();
  }, [reload]);

  // Rebuild the master search index once on startup so global search is complete
  // and self-heals any drift (deletes/edits made while the app was closed).
  useEffect(() => {
    api.reindexAll().catch((e) => console.error("reindex failed", e));
  }, []);

  // Load persisted app config (grammar, templates, Refine) once on startup.
  useEffect(() => {
    api
      .getAppConfig()
      .then((cfg) =>
        setState((s) => ({
          ...s,
          grammarEnabled: cfg.settings.grammarEnabled,
          pageTemplates: cfg.pageTemplates ?? [],
          refineEnabled: cfg.settings.refineEnabled,
          refineAdherence: cfg.settings.refineAdherence,
          refineModelTier: cfg.settings.refineModelTier,
          refineTemplates: cfg.refineTemplates ?? [],
          firstRunComplete: cfg.settings.firstRunComplete,
          configLoaded: true,
        })),
      )
      .catch((e) => {
        console.error("load app config failed", e);
        // Don't trap the app behind a never-loading first-run gate.
        setState((s) => ({ ...s, configLoaded: true }));
      });
  }, []);

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
      await reloadPages(notebookId, sectionId);
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

  const actions: VellumActions = {
    reload,
    refreshPages: refreshSelectedPages,
    clearError: () => setState((s) => ({ ...s, error: null })),
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
        await reload();
        return nb;
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
        await api.deleteNotebook(id);
        setState((s) => {
          const wasSelected = s.selectedNotebookId === id;
          return {
            ...s,
            selectedNotebookId: wasSelected ? null : s.selectedNotebookId,
            selectedSectionId: wasSelected ? null : s.selectedSectionId,
            selectedPageId: wasSelected ? null : s.selectedPageId,
            pages: wasSelected ? [] : s.pages,
          };
        });
        await reload();
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
        const section = await api.createSection(notebookId, name);
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
        await api.deleteSection(notebookId, sectionId);
        setState((s) => {
          const wasSelected = s.selectedSectionId === sectionId;
          return {
            ...s,
            selectedSectionId: wasSelected ? null : s.selectedSectionId,
            selectedPageId: wasSelected ? null : s.selectedPageId,
            pages: wasSelected ? [] : s.pages,
          };
        });
        await afterSectionChange(notebookId);
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
        await api.deletePage(notebookId, pageId);
        setState((s) => ({
          ...s,
          selectedPageId: s.selectedPageId === pageId ? null : s.selectedPageId,
        }));
        await refreshSelectedPages();
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
        await api.movePage(notebookId, pageId, toSectionId);
        setState((s) => ({
          ...s,
          selectedPageId: s.selectedPageId === pageId ? null : s.selectedPageId,
        }));
        await refreshSelectedPages();
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
