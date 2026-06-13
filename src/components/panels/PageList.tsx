import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { EditableLabel } from "../ui/EditableLabel";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import { reorderByDrop } from "../dnd";
import { handleListArrows } from "../keyboard";
import "./PageList.css";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Right panel: pages of the selected section (spec Section 5). */
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
  const [dragId, setDragId] = useState<string | null>(null);

  if (!selectedNotebookId || !selectedSectionId) {
    return (
      <div className="v-pagelist">
        <div className="v-pagelist__placeholder">Select a section to see its pages.</div>
      </div>
    );
  }
  const notebookId = selectedNotebookId;
  const sectionId = selectedSectionId;

  const otherSections =
    notebooks.find((n) => n.id === notebookId)?.sections?.filter((s) => s.id !== sectionId) ??
    [];

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
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

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const order = reorderByDrop(pages.map((p) => p.id), dragId, targetId);
    actions.reorderPages(notebookId, order);
  };

  return (
    <div className="v-pagelist">
      <div className="v-pagelist__header">
        <Button icon="document--plus" onClick={() => actions.createPage(notebookId, sectionId)}>
          New Page
        </Button>
      </div>
      <div
        className="v-pagelist__items"
        onKeyDown={(e) => handleListArrows(e, ".v-pagelist__item")}
      >
        {pages.map((p) => (
          <div
            key={p.id}
            className={[
              "v-pagelist__item",
              p.id === selectedPageId ? "v-pagelist__item--selected" : "",
            ].join(" ")}
            draggable={editingId !== p.id}
            onDragStart={() => setDragId(p.id)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={() => onDrop(p.id)}
            onDragEnd={() => setDragId(null)}
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
            <span className="v-pagelist__date">{formatDate(p.updatedAt)}</span>
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
