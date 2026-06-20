import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { EditableLabel } from "../ui/EditableLabel";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import { PALETTE, DEFAULT_NOTEBOOK_COLOR, DEFAULT_SECTION_COLOR } from "../../data/palette";
import { reorderByDrop } from "../dnd";
import { handleListArrows } from "../keyboard";
import "./NavPanel.css";

type Drag =
  | { kind: "notebook"; id: string }
  | { kind: "section"; id: string; notebookId: string }
  | null;

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Left panel: collapsible notebook → section tree (spec Section 5). */
export function NavPanel({ onOpenSectionProperties }: { onOpenSectionProperties: (notebookId: string, sectionId: string) => void }) {
  const { notebooks, selectedSectionId, actions } = useVellum();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<Drag>(null);

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const colorSubmenu = (
    current: string | null,
    apply: (color: string | null) => void,
  ): MenuItem[] => [
    ...PALETTE.map((c) => ({
      label: c.name,
      swatch: c.value,
      checked: current === c.value,
      onSelect: () => apply(c.value),
    })),
    { label: "None", onSelect: () => apply(null), separatorAfter: false },
  ];

  const notebookMenu = (nbId: string, color: string | null): MenuItem[] => [
    {
      label: "Add Section",
      icon: "folder--plus",
      onSelect: async () => {
        const s = await actions.createSection(nbId, "New Section");
        if (s) setEditingId(s.id);
      },
    },
    {
      label: "Rename",
      icon: "card--pencil",
      onSelect: () => setEditingId(nbId),
    },
    {
      label: "Change color",
      icon: "edit-color",
      submenu: colorSubmenu(color, (c) => actions.setNotebookColor(nbId, c)),
      separatorAfter: true,
    },
    {
      label: "Delete Notebook",
      icon: "cross",
      danger: true,
      onSelect: () => confirmDeleteNotebook(nbId),
    },
  ];

  const sectionMenu = (
    nbId: string,
    sectionId: string,
    name: string,
    color: string | null,
    pageTemplateId: string | null,
  ): MenuItem[] => [
    {
      label: "Add Page",
      icon: "document--plus",
      onSelect: () => actions.createPage(nbId, sectionId),
    },
    { label: "Rename", icon: "card--pencil", onSelect: () => setEditingId(sectionId) },
    {
      label: "Change color",
      icon: "edit-color",
      // Preserve the section's page-template assignment — update_section writes
      // every column, so passing null here would silently clear it.
      submenu: colorSubmenu(color, (c) =>
        actions.updateSection(nbId, sectionId, name, c, pageTemplateId),
      ),
    },
    {
      label: "Properties…",
      icon: "gear",
      onSelect: () => onOpenSectionProperties(nbId, sectionId),
      separatorAfter: true,
    },
    {
      label: "Delete Section",
      icon: "cross",
      danger: true,
      onSelect: () => confirmDeleteSection(nbId, sectionId, name),
    },
  ];

  async function confirmDeleteNotebook(nbId: string) {
    const nb = notebooks.find((n) => n.id === nbId);
    const ok = await ask(
      `Delete notebook "${nb?.name}" and everything in it? This cannot be undone.`,
      { title: "Delete Notebook", kind: "warning" },
    );
    if (ok) actions.deleteNotebook(nbId);
  }

  async function confirmDeleteSection(nbId: string, sectionId: string, name: string) {
    const ok = await ask(
      `Delete section "${name}" and all its pages? This cannot be undone.`,
      { title: "Delete Section", kind: "warning" },
    );
    if (ok) actions.deleteSection(nbId, sectionId);
  }

  const onNotebookDrop = (targetId: string) => {
    if (drag?.kind !== "notebook" || drag.id === targetId) return;
    const order = reorderByDrop(
      notebooks.map((n) => n.id),
      drag.id,
      targetId,
    );
    actions.reorderNotebooks(order);
  };

  const onSectionDrop = (nbId: string, targetId: string) => {
    if (drag?.kind !== "section" || drag.notebookId !== nbId) return;
    const nb = notebooks.find((n) => n.id === nbId);
    if (!nb?.sections) return;
    const order = reorderByDrop(
      nb.sections.map((s) => s.id),
      drag.id,
      targetId,
    );
    actions.reorderSections(nbId, order);
  };

  return (
    <div className="v-nav">
      <div className="v-nav__header">
        <Button
          icon="book--plus"
          onClick={async () => {
            const nb = await actions.createNotebook("New Notebook");
            if (nb) {
              await actions.toggleNotebook(nb.id); // expand
              setEditingId(nb.id);
            }
          }}
        >
          New Notebook
        </Button>
      </div>

      <div
        className="v-nav__tree"
        role="tree"
        onKeyDown={(e) => handleListArrows(e, ".v-nav__notebook, .v-nav__section")}
      >
        {notebooks.map((nb) => (
          <div
            key={nb.id}
            role="treeitem"
            aria-expanded={nb.expanded}
            className="v-nav__group"
            style={{ ["--nb-color" as string]: nb.color ?? DEFAULT_NOTEBOOK_COLOR }}
          >
            <div
              className="v-nav__notebook"
              draggable={editingId !== nb.id}
              onDragStart={() => setDrag({ kind: "notebook", id: nb.id })}
              onDragOver={(e) => drag?.kind === "notebook" && e.preventDefault()}
              onDrop={() => onNotebookDrop(nb.id)}
              onClick={() => actions.toggleNotebook(nb.id)}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  setEditingId(nb.id);
                }
              }}
              tabIndex={0}
              onContextMenu={(e) => openMenu(e, notebookMenu(nb.id, nb.color))}
            >
              <span className={`v-nav__twisty ${nb.expanded ? "v-nav__twisty--open" : ""}`} />
              <Icon name={nb.expanded ? "book-open" : "book"} />
              <EditableLabel
                className="v-nav__name"
                value={nb.name}
                editing={editingId === nb.id}
                onCommit={(name) => {
                  actions.renameNotebook(nb.id, name);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </div>

            {nb.expanded &&
              (nb.sections ?? []).map((s) => (
                <div
                  key={s.id}
                  className={[
                    "v-nav__section",
                    s.id === selectedSectionId ? "v-nav__section--selected" : "",
                  ].join(" ")}
                  draggable={editingId !== s.id}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setDrag({ kind: "section", id: s.id, notebookId: nb.id });
                  }}
                  onDragOver={(e) =>
                    drag?.kind === "section" &&
                    drag.notebookId === nb.id &&
                    e.preventDefault()
                  }
                  onDrop={() => onSectionDrop(nb.id, s.id)}
                  onClick={() => actions.selectSection(nb.id, s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "F2") {
                      e.preventDefault();
                      setEditingId(s.id);
                    }
                  }}
                  tabIndex={0}
                  onContextMenu={(e) =>
                    openMenu(e, sectionMenu(nb.id, s.id, s.name, s.color, s.pageTemplateId))
                  }
                >
                  <span
                    className="v-nav__swatch v-nav__swatch--section"
                    style={{ background: s.color ?? DEFAULT_SECTION_COLOR }}
                  />
                  <EditableLabel
                    className="v-nav__name"
                    value={s.name}
                    editing={editingId === s.id}
                    onCommit={(name) => {
                      actions.renameSection(nb.id, s.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ))}

            {nb.expanded && nb.sections?.length === 0 && (
              <div className="v-nav__empty">No sections yet</div>
            )}
          </div>
        ))}

        {notebooks.length === 0 && (
          <div className="v-nav__empty">
            No notebooks yet. Click <b>New Notebook</b> to start.
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
