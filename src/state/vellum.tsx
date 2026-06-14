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
import type { Notebook, Page, PageTemplate, Section } from "../data/types";

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
  error: string | null;
}

const initial: VellumState = {
  notebooks: [],
  pages: [],
  selectedNotebookId: null,
  selectedSectionId: null,
  selectedPageId: null,
  searchHighlight: "",
  grammarEnabled: false,
  pageTemplates: [],
  error: null,
};

interface VellumActions {
  reload: () => Promise<void>;
  refreshPages: () => Promise<void>;
  clearError: () => void;
  toggleNotebook: (id: string) => Promise<void>;
  selectSection: (notebookId: string, sectionId: string) => Promise<void>;
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

  createPage: (notebookId: string, sectionId: string, title?: string) => Promise<void>;
  setPageTitle: (notebookId: string, pageId: string, title: string) => Promise<void>;
  deletePage: (notebookId: string, pageId: string) => Promise<void>;
  duplicatePage: (notebookId: string, pageId: string) => Promise<void>;
  movePage: (notebookId: string, pageId: string, toSectionId: string) => Promise<void>;
  reorderPages: (notebookId: string, orderedIds: string[]) => Promise<void>;
}

type VellumContextValue = VellumState & { actions: VellumActions };

const VellumContext = createContext<VellumContextValue | null>(null);

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

  // Load persisted app config (grammar on/off, page templates) once on startup.
  useEffect(() => {
    api
      .getAppConfig()
      .then((cfg) =>
        setState((s) => ({
          ...s,
          grammarEnabled: cfg.settings.grammarEnabled,
          pageTemplates: cfg.pageTemplates ?? [],
        })),
      )
      .catch((e) => console.error("load app config failed", e));
  }, []);

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
