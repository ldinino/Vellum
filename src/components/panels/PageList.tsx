import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { EditableLabel } from "../ui/EditableLabel";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import { DEFAULT_SECTION_COLOR } from "../../data/palette";
import type { PageSortDir, PageSortMode } from "../../data/types";
import { useReorderDrag } from "../useReorderDrag";
import { handleListArrows } from "../keyboard";
import "./PageList.css";

const SORT_LABELS: Record<PageSortMode, string> = {
  custom: "Manual order",
  created: "Date created",
  modified: "Date modified",
};

/** Right panel: title-only page-tab strip for the selected section (spec Section 5). */
export function PageList() {
  const {
    notebooks,
    pages,
    selectedNotebookId,
    selectedSectionId,
    selectedPageId,
    actions,
  } = useVellum();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Manual page reorder (drag-and-drop) — shared logic, see useReorderDrag.
  const dnd = useReorderDrag({
    axis: "vertical",
    idsOf: () => pages.map((p) => p.id),
    onReorder: (order) =>
      selectedNotebookId && actions.reorderPages(selectedNotebookId, order),
    dropClassBase: "v-pagelist__item",
  });

  if (!selectedNotebookId || !selectedSectionId) {
    return (
      <div className="v-pagelist">
        <div className="v-pagelist__placeholder">Select a section to see its pages.</div>
      </div>
    );
  }
  const notebookId = selectedNotebookId;
  const sectionId = selectedSectionId;

  const section = notebooks
    .find((n) => n.id === notebookId)
    ?.sections?.find((s) => s.id === sectionId);
  const otherSections =
    notebooks.find((n) => n.id === notebookId)?.sections?.filter((s) => s.id !== sectionId) ??
    [];

  const sortMode: PageSortMode = section?.pageSortMode ?? "custom";
  const sortDir: PageSortDir = section?.pageSortDir ?? "asc";
  // Drag-to-reorder only makes sense for the manual ("custom") order.
  const dragEnabled = sortMode === "custom";

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const sortMenu = (): MenuItem[] => {
    const setMode = (mode: PageSortMode) =>
      actions.setSectionSort(notebookId, sectionId, mode, sortDir);
    const setDir = (dir: PageSortDir) =>
      actions.setSectionSort(notebookId, sectionId, sortMode, dir);
    return [
      { label: "Manual order", checked: sortMode === "custom", onSelect: () => setMode("custom") },
      { label: "Date created", checked: sortMode === "created", onSelect: () => setMode("created") },
      {
        label: "Date modified",
        checked: sortMode === "modified",
        onSelect: () => setMode("modified"),
        separatorAfter: true,
      },
      {
        label: "Ascending",
        checked: sortDir === "asc",
        disabled: sortMode === "custom",
        onSelect: () => setDir("asc"),
      },
      {
        label: "Descending",
        checked: sortDir === "desc",
        disabled: sortMode === "custom",
        onSelect: () => setDir("desc"),
      },
    ];
  };

  const pageMenu = (pageId: string, title: string): MenuItem[] => [
    { label: "Rename", icon: "card--pencil", onSelect: () => setEditingId(pageId) },
    {
      label: "Duplicate",
      icon: "documents-stack",
      onSelect: () => actions.duplicatePage(notebookId, pageId),
    },
    {
      label: "Move to section",
      icon: "blue-folder",
      disabled: otherSections.length === 0,
      submenu: otherSections.map((s) => ({
        label: s.name,
        // Color chip matching the section's square in the notebook tree
        // (NavPanel) so the two reads of a section stay consistent.
        swatch: s.color ?? DEFAULT_SECTION_COLOR,
        onSelect: () => actions.movePage(notebookId, pageId, s.id),
      })),
      separatorAfter: true,
    },
    {
      label: "Delete Page",
      icon: "cross",
      danger: true,
      onSelect: async () => {
        const ok = await ask(`Delete page "${title || "Untitled page"}"? This cannot be undone.`, {
          title: "Delete Page",
          kind: "warning",
        });
        if (ok) actions.deletePage(notebookId, pageId);
      },
    },
  ];

  return (
    <div className="v-pagelist">
      <div className="v-pagelist__header">
        <Button icon="document--plus" onClick={() => actions.createPage(notebookId, sectionId)}>
          New Page
        </Button>
        <Button
          className="v-pagelist__sort"
          icon="edit-list-order"
          title={`Sort pages: ${SORT_LABELS[sortMode]}${
            sortMode === "custom" ? "" : sortDir === "asc" ? " (ascending)" : " (descending)"
          }`}
          aria-label="Sort pages"
          onClick={(e) => openMenu(e, sortMenu())}
        />
      </div>
      <div
        className="v-pagelist__items"
        onKeyDown={(e) => handleListArrows(e, ".v-pagelist__item")}
        onDragEnter={dnd.onContainerDragOver}
        onDragOver={dnd.onContainerDragOver}
        onDrop={dnd.onContainerDrop}
        onDragLeave={dnd.onContainerDragLeave}
      >
        {pages.map((p) => (
          <div
            key={p.id}
            data-dnd-id={p.id}
            className={[
              "v-pagelist__item",
              p.id === selectedPageId ? "v-pagelist__item--selected" : "",
              p.id === dnd.draggingId ? "v-pagelist__item--dragging" : "",
              dnd.dropClass(p.id),
            ].join(" ")}
            draggable={dragEnabled && editingId !== p.id}
            onDragStart={(e) => dragEnabled && dnd.onItemDragStart(e, p.id)}
            onDragEnd={dnd.onItemDragEnd}
            onClick={() => actions.selectPage(p.id)}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                setEditingId(p.id);
              }
            }}
            tabIndex={0}
            onContextMenu={(e) => openMenu(e, pageMenu(p.id, p.title))}
          >
            <EditableLabel
              className="v-pagelist__title"
              value={p.title}
              placeholder="Untitled page"
              editing={editingId === p.id}
              onCommit={(title) => {
                actions.setPageTitle(notebookId, p.id, title);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          </div>
        ))}
        {pages.length === 0 && (
          <div className="v-pagelist__placeholder">
            No pages yet. Click <b>New Page</b>.
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
