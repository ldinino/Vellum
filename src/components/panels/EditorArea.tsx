import { useVellum } from "../../state/vellum";
import { PageEditor } from "../editor/PageEditor";
import "./EditorArea.css";

/**
 * Main area for the selected page. Delegates to a per-page Tiptap editor
 * (keyed by page id so each page gets a clean instance with its own auto-save).
 */
export function EditorArea() {
  const { pages, selectedNotebookId, selectedPageId } = useVellum();
  const page = pages.find((p) => p.id === selectedPageId);

  if (!page || !selectedNotebookId) {
    return (
      <div className="v-editor">
        <div className="v-editor__empty">
          <p>Select a page, or create one, to start writing.</p>
        </div>
      </div>
    );
  }

  return <PageEditor key={page.id} notebookId={selectedNotebookId} page={page} />;
}
