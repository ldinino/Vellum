import { useState } from "react";
import { NavPanel } from "./panels/NavPanel";
import { PageList } from "./panels/PageList";
import { EditorArea } from "./panels/EditorArea";
import { SectionPropertiesModal } from "./panels/SectionPropertiesModal";
import { SearchBar } from "./search/SearchBar";
import { SettingsModal } from "./settings/SettingsModal";
import { FirstRunModal } from "./settings/FirstRunModal";
import { useVellum } from "../state/vellum";
import { DEFAULT_SECTION_COLOR } from "../data/palette";
import { Icon } from "./ui/Icon";
import "./VellumShell.css";

/** Three-panel navigation shell: notebook tree | editor | page-tab strip. */
export function VellumShell() {
  const { error, actions, notebooks, selectedNotebookId, selectedSectionId } = useVellum();
  const [secProps, setSecProps] = useState<{ notebookId: string; sectionId: string } | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The open section's color tints the page border + page-tab strip (OneNote
  // 2007). Derived from loaded state; defaults until a section is selected.
  const sectionColor =
    notebooks
      .find((n) => n.id === selectedNotebookId)
      ?.sections?.find((s) => s.id === selectedSectionId)?.color ?? DEFAULT_SECTION_COLOR;

  return (
    <div
      className="v-shell"
      style={{ ["--section-color" as string]: sectionColor }}
    >
      <SearchBar onOpenSettings={() => setSettingsOpen(true)} />
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
          onOpenSectionProperties={(notebookId, sectionId) =>
            setSecProps({ notebookId, sectionId })
          }
        />
        <EditorArea />
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
