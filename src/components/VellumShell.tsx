import { useState } from "react";
import { NavPanel } from "./panels/NavPanel";
import { PageList } from "./panels/PageList";
import { EditorArea } from "./panels/EditorArea";
import { SectionPropertiesModal } from "./panels/SectionPropertiesModal";
import { SearchBar } from "./search/SearchBar";
import { useVellum } from "../state/vellum";
import { Icon } from "./ui/Icon";
import "./VellumShell.css";

/** Three-panel navigation shell: notebook tree | page list | editor. */
export function VellumShell() {
  const { error, actions } = useVellum();
  const [secProps, setSecProps] = useState<{ notebookId: string; sectionId: string } | null>(
    null,
  );

  return (
    <div className="v-shell">
      <SearchBar />
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
        <PageList />
        <EditorArea />
      </div>

      {secProps && (
        <SectionPropertiesModal
          notebookId={secProps.notebookId}
          sectionId={secProps.sectionId}
          open
          onClose={() => setSecProps(null)}
        />
      )}
    </div>
  );
}
