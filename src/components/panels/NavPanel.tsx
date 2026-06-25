import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { EditableLabel } from "../ui/EditableLabel";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import { DEFAULT_NOTEBOOK_COLOR, DEFAULT_SECTION_COLOR } from "../../data/palette";
import { buildSectionMenu, colorSubmenu } from "./sectionMenu";
import { useReorderDrag } from "../useReorderDrag";
import { handleListArrows } from "../keyboard";
import "./NavPanel.css";

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface NavPanelProps {
  /** Collapsed = thin vertical notebook rail; expanded = full tree. */
  collapsed: boolean;
  onToggle: () => void;
  onOpenSectionProperties: (notebookId: string, sectionId: string) => void;
  onOpenRecycleBin: () => void;
}

/** Left panel: notebook → section tree, or a thin notebook rail when collapsed
 * (spec Section 5). */
export function NavPanel({
  collapsed,
  onToggle,
  onOpenSectionProperties,
  onOpenRecycleBin,
}: NavPanelProps) {
  const { notebooks, selectedNotebookId, selectedSectionId, recycleBinCount, actions } =
    useVellum();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Reorder drag-and-drop — notebooks among notebooks, sections within their own
  // notebook (data-dnd-group = notebook id). Both share the tree container; each
  // hook acts only on its own kind of drag, so their handlers compose on it.
  const nbDnd = useReorderDrag({
    axis: "vertical",
    idsOf: () => notebooks.map((n) => n.id),
    onReorder: (order) => actions.reorderNotebooks(order),
    dropClassBase: "v-nav__group",
  });
  const secDnd = useReorderDrag({
    axis: "vertical",
    idsOf: (group) =>
      notebooks.find((n) => n.id === group)?.sections?.map((s) => s.id) ?? [],
    onReorder: (order, group) => group && actions.reorderSections(group, order),
    dropClassBase: "v-nav__section",
  });

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Invoked from both the expanded tree and the collapsed rail. The rail has no
  // inline label to edit, so for the editing actions reveal the tree first:
  // expand the panel (and the notebook itself for Add Section) before entering
  // the editor. All no-ops when already expanded.
  const notebookMenu = (nbId: string, color: string | null): MenuItem[] => [
    {
      label: "Add Section",
      icon: "folder--plus",
      onSelect: async () => {
        if (collapsed) {
          onToggle();
          const nb = notebooks.find((n) => n.id === nbId);
          if (nb && !nb.expanded) await actions.toggleNotebook(nbId);
        }
        const s = await actions.createSection(nbId, "New Section");
        if (s) setEditingId(s.id);
      },
    },
    {
      label: "Rename",
      icon: "card--pencil",
      onSelect: () => {
        if (collapsed) onToggle();
        setEditingId(nbId);
      },
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
      // Recoverable via the Recycle Bin (spec Section 5.1) — no confirmation.
      onSelect: () => actions.deleteNotebook(nbId),
    },
  ];

  // Right-click menu for the Recycle Bin button (both nav states).
  const recycleBinMenu = (): MenuItem[] => [
    { label: "Open Recycle Bin", icon: "bin-full", onSelect: onOpenRecycleBin },
    {
      label: "Empty Recycle Bin",
      icon: "broom",
      danger: true,
      disabled: recycleBinCount === 0,
      onSelect: confirmEmptyBin,
    },
  ];

  async function confirmEmptyBin() {
    const ok = await ask(
      `Permanently delete all ${recycleBinCount} item(s) in the Recycle Bin? This cannot be undone.`,
      { title: "Empty Recycle Bin", kind: "warning" },
    );
    if (ok) actions.emptyRecycleBin();
  }

  if (collapsed) {
    return (
      <div className="v-nav v-nav--collapsed">
        <button
          type="button"
          className="v-nav__chevron"
          title="Show notebooks"
          aria-label="Show notebooks"
          onClick={onToggle}
        >
          <Icon name="control" />
        </button>
        <div className="v-nav__rail">
          {notebooks.map((nb) => (
            <button
              key={nb.id}
              type="button"
              className={[
                "v-nav__rail-item",
                nb.id === selectedNotebookId ? "v-nav__rail-item--selected" : "",
              ].join(" ")}
              style={{ ["--nb-color" as string]: nb.color ?? DEFAULT_NOTEBOOK_COLOR }}
              title={nb.name}
              onClick={() => actions.selectNotebook(nb.id)}
              onContextMenu={(e) => openMenu(e, notebookMenu(nb.id, nb.color))}
            >
              <span className="v-nav__rail-label">{nb.name}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="v-nav__rail-bin"
          title="Recycle Bin"
          aria-label="Recycle Bin"
          onClick={onOpenRecycleBin}
          onContextMenu={(e) => openMenu(e, recycleBinMenu())}
        >
          <Icon name={recycleBinCount > 0 ? "bin-full" : "bin-metal"} />
        </button>
        {menu && (
          <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
        )}
      </div>
    );
  }

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
        <button
          type="button"
          className="v-nav__chevron"
          title="Hide notebooks"
          aria-label="Hide notebooks"
          onClick={onToggle}
        >
          <Icon name="control-180" />
        </button>
      </div>

      <div
        className="v-nav__tree"
        role="tree"
        onKeyDown={(e) => handleListArrows(e, ".v-nav__notebook, .v-nav__section")}
        onDragEnter={(e) => {
          nbDnd.onContainerDragOver(e);
          secDnd.onContainerDragOver(e);
        }}
        onDragOver={(e) => {
          nbDnd.onContainerDragOver(e);
          secDnd.onContainerDragOver(e);
        }}
        onDrop={(e) => {
          nbDnd.onContainerDrop(e);
          secDnd.onContainerDrop(e);
        }}
        onDragLeave={(e) => {
          nbDnd.onContainerDragLeave(e);
          secDnd.onContainerDragLeave(e);
        }}
      >
        {notebooks.map((nb) => (
          <div
            key={nb.id}
            role="treeitem"
            aria-expanded={nb.expanded}
            data-dnd-id={nb.id}
            className={[
              "v-nav__group",
              nb.id === nbDnd.draggingId ? "v-nav__group--dragging" : "",
              nbDnd.dropClass(nb.id),
            ].join(" ")}
            style={{ ["--nb-color" as string]: nb.color ?? DEFAULT_NOTEBOOK_COLOR }}
          >
            <div
              className="v-nav__notebook"
              draggable={editingId !== nb.id}
              onDragStart={(e) => nbDnd.onItemDragStart(e, nb.id)}
              onDragEnd={nbDnd.onItemDragEnd}
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
                  data-dnd-id={s.id}
                  data-dnd-group={nb.id}
                  className={[
                    "v-nav__section",
                    s.id === selectedSectionId ? "v-nav__section--selected" : "",
                    s.id === secDnd.draggingId ? "v-nav__section--dragging" : "",
                    secDnd.dropClass(s.id),
                  ].join(" ")}
                  draggable={editingId !== s.id}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    secDnd.onItemDragStart(e, s.id, nb.id);
                  }}
                  onDragEnd={secDnd.onItemDragEnd}
                  onClick={() => actions.selectSection(nb.id, s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "F2") {
                      e.preventDefault();
                      setEditingId(s.id);
                    }
                  }}
                  tabIndex={0}
                  onContextMenu={(e) =>
                    openMenu(
                      e,
                      buildSectionMenu({
                        notebookId: nb.id,
                        section: s,
                        actions,
                        onRename: () => setEditingId(s.id),
                        onOpenProperties: () => onOpenSectionProperties(nb.id, s.id),
                      }),
                    )
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

      <button
        type="button"
        className="v-nav__recyclebin"
        title="Recycle Bin"
        onClick={onOpenRecycleBin}
        onContextMenu={(e) => openMenu(e, recycleBinMenu())}
      >
        <Icon name={recycleBinCount > 0 ? "bin-full" : "bin-metal"} />
        <span className="v-nav__recyclebin-label">Recycle Bin</span>
      </button>

      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
