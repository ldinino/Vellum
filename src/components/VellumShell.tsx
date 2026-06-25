import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NavPanel } from "./panels/NavPanel";
import { PageList } from "./panels/PageList";
import { EditorArea } from "./panels/EditorArea";
import { SectionTabs } from "./panels/SectionTabs";
import { SectionPropertiesModal } from "./panels/SectionPropertiesModal";
import { RecycleBinModal } from "./panels/RecycleBinModal";
import { MenuBar } from "./MenuBar";
import { TopToolbar } from "./editor/EditorToolbar";
import { SearchBox } from "./search/SearchBar";
import { FindBar } from "./editor/FindBar";
import { OPEN_FIND_EVENT } from "./editor/find";
import { SettingsModal } from "./settings/SettingsModal";
import { FirstRunModal } from "./settings/FirstRunModal";
import { AppContextMenus } from "./AppContextMenus";
import { useVellum } from "../state/vellum";
import { useActiveEditor } from "../state/activeEditor";
import { printCurrentPage } from "../lib/print-page";
import { DEFAULT_SECTION_COLOR } from "../data/palette";
import { Icon } from "./ui/Icon";
import "./VellumShell.css";

const NAV_COLLAPSED_KEY = "vellum.navCollapsed";

/**
 * App shell: the formatting toolbar over a body split into the notebook nav
 * (left) and a main column (right). The main column stacks a tab row — section
 * tabs on the left, search box pinned top-right above the page strip — over the
 * content row: editor (center) | page-tab strip (right). (OneNote 2007 layout.)
 */
export function VellumShell() {
  const { error, actions, notebooks, pages, selectedNotebookId, selectedSectionId, selectedPageId } =
    useVellum();
  const { active } = useActiveEditor();
  // Always-current ref to the open page's inline-image cleanup, so the close
  // listener (registered once) sweeps whichever page is open at quit time.
  const cleanupImagesRef = useRef<(() => Promise<void>) | null>(null);
  cleanupImagesRef.current = active?.cleanupImages ?? null;

  // Final check before the window closes: run the open page's inline-image
  // cleanup (it never gets a navigate-away), then destroy the window. Catches the
  // titlebar close, File ▸ Exit, and Alt+F4 — all call window.close().
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let closing = false;
    let unlisten: (() => void) | undefined;
    win
      .onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        event.preventDefault();
        try {
          const run = cleanupImagesRef.current?.() ?? Promise.resolve();
          await Promise.race([run, new Promise<void>((r) => setTimeout(r, 1500))]);
        } catch {
          /* best effort — never block the close */
        }
        await win.destroy();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  const [secProps, setSecProps] = useState<{ notebookId: string; sectionId: string } | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleNav = useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }, []);

  const openSectionProperties = useCallback(
    (notebookId: string, sectionId: string) => setSecProps({ notebookId, sectionId }),
    [],
  );

  // In-page find (Ctrl+F): our own box instead of WebView2's native find.
  const [findOpen, setFindOpen] = useState(false);
  const [findTick, setFindTick] = useState(0);
  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindTick((t) => t + 1);
  }, []);
  const closeFind = useCallback(() => setFindOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault(); // suppress WebView2's built-in find
        openFind();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_FIND_EVENT, openFind);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_FIND_EVENT, openFind);
    };
  }, [openFind]);

  // Print the open page (Ctrl+P): render its content into an isolated iframe and
  // print that, replacing WebView2's native print (disabled in release builds).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "p" || e.key === "P")
      ) {
        e.preventDefault();
        const editor = active?.editor;
        if (selectedPageId && selectedNotebookId && editor) {
          const title = pages.find((p) => p.id === selectedPageId)?.title ?? "";
          void printCurrentPage({
            editor,
            notebookId: selectedNotebookId,
            pageId: selectedPageId,
            title,
            onError: actions.setError,
          });
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedPageId, selectedNotebookId, pages, active, actions]);

  // The open section's color tints the page border + page-tab strip (OneNote
  // 2007). Derived from loaded state; defaults until a section is selected.
  const sectionColor =
    notebooks
      .find((n) => n.id === selectedNotebookId)
      ?.sections?.find((s) => s.id === selectedSectionId)?.color ?? DEFAULT_SECTION_COLOR;

  return (
    <div className="v-shell" style={{ ["--section-color" as string]: sectionColor }}>
      <MenuBar
        onOpenSettings={(tab) => {
          setSettingsTab(tab ?? "general");
          setSettingsOpen(true);
        }}
      />
      <TopToolbar />

      {error && (
        <div className="v-shell__error" role="alert">
          <Icon name="exclamation" />
          <span>{error}</span>
          <button type="button" onClick={actions.clearError} aria-label="Dismiss">
            <Icon name="cross-small" />
          </button>
        </div>
      )}
      <div className="v-shell__body">
        <NavPanel
          collapsed={navCollapsed}
          onToggle={toggleNav}
          onOpenSectionProperties={openSectionProperties}
          onOpenRecycleBin={() => setRecycleBinOpen(true)}
        />
        <div className="v-shell__main">
          {/* Tab row spans the editor + page strip: section tabs on the left,
              the search box pinned top-right above the page strip (OneNote 2007). */}
          <div className="v-shell__tabrow">
            <SectionTabs
              navCollapsed={navCollapsed}
              onToggleNav={toggleNav}
              onOpenSectionProperties={openSectionProperties}
            />
            <SearchBox />
          </div>
          <div className="v-shell__content">
            <EditorArea />
            <PageList />
            {findOpen && <FindBar onClose={closeFind} focusTick={findTick} />}
          </div>
        </div>
      </div>

      {secProps && (
        <SectionPropertiesModal
          notebookId={secProps.notebookId}
          sectionId={secProps.sectionId}
          open
          onClose={() => setSecProps(null)}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
      />
      <RecycleBinModal open={recycleBinOpen} onClose={() => setRecycleBinOpen(false)} />
      <FirstRunModal />
      <AppContextMenus />
    </div>
  );
}
