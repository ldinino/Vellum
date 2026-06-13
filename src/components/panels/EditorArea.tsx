import { useEffect, useRef, useState } from "react";
import { useVellum } from "../../state/vellum";
import "./EditorArea.css";

/**
 * Main area for the selected page: an editable page title (h1, outside the
 * content area per spec Section 5) plus a placeholder body. The Tiptap editor
 * replaces the placeholder in Phase 2.
 */
export function EditorArea() {
  const { pages, selectedNotebookId, selectedPageId, actions } = useVellum();
  const page = pages.find((p) => p.id === selectedPageId);
  const [title, setTitle] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(page?.title ?? "");
    // Focus the title of a freshly created (untitled) page so the user can
    // just start typing its name.
    if (page && page.title === "") {
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [page?.id, page?.title]);

  if (!page || !selectedNotebookId) {
    return (
      <div className="v-editor">
        <div className="v-editor__empty">
          <p>Select a page, or create one, to start writing.</p>
        </div>
      </div>
    );
  }
  const notebookId = selectedNotebookId;

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed !== page.title) actions.setPageTitle(notebookId, page.id, trimmed);
  };

  return (
    <div className="v-editor">
      <input
        ref={titleRef}
        className="v-editor__title"
        value={title}
        placeholder="Untitled page"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitTitle();
            titleRef.current?.blur();
          }
        }}
      />
      <div className="v-editor__content">
        <p className="v-editor__placeholder">
          The rich text editor arrives in Phase 2. For now this page exists, its
          title saves to the notebook database, and it survives a restart.
        </p>
      </div>
    </div>
  );
}
