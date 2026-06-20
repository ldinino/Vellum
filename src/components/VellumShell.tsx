import { useCallback, useState } from "react";
import { NavPanel } from "./panels/NavPanel";
import { PageList } from "./panels/PageList";
import { EditorArea } from "./panels/EditorArea";
import { SectionTabs } from "./panels/SectionTabs";
import { SectionPropertiesModal } from "./panels/SectionPropertiesModal";
import { MenuBar } from "./MenuBar";
import { TopToolbar } from "./editor/EditorToolbar";
import { SettingsModal } from "./settings/SettingsModal";
import { FirstRunModal } from "./settings/FirstRunModal";
import { useVellum } from "../state/vellum";
import { DEFAULT_SECTION_COLOR } from "../data/palette";
import { Icon } from "./ui/Icon";
import "./VellumShell.css";

const NAV_COLLAPSED_KEY = "vellum.navCollapsed";

/**
 * App shell: a unified top toolbar (formatting + search) over a three-region
 * body — notebook nav (left) | section tabs + editor (center) | page-tab strip
 * (right).
 */
export function VellumShell() {
  const { error, actions, notebooks, selectedNotebookId, selectedSectionId } = useVellum();
  const [secProps, setSecProps] = useState<{ notebookId: string; sectionId: string } | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // The open section's color tints the page border + page-tab strip (OneNote
  // 2007). Derived from loaded state; defaults until a section is selected.
  const sectionColor =
    notebooks
      .find((n) => n.id === selectedNotebookId)
      ?.sections?.find((s) => s.id === selectedSectionId)?.color ?? DEFAULT_SECTION_COLOR;

  return (
    <div className="v-shell" style={{ ["--section-color" as string]: sectionColor }}>
      <MenuBar onOpenSettings={() => setSettingsOpen(true)} />
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
        />
        <div className="v-shell__center">
          <SectionTabs
            navCollapsed={navCollapsed}
            onToggleNav={toggleNav}
            onOpenSectionProperties={openSectionProperties}
          />
          <EditorArea />
        </div>
        <PageList />
      </div>

      {secProps && (
        <SectionPropertiesModal
          notebookId={secProps.notebookId}
          sectionId={secProps.sectionId}
          open
          onClose={() => setSecProps(null)}
        />
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FirstRunModal />
    </div>
  );
}
