/**
 * Horizontal section-tab row (OneNote 2007), shown above the editor. The current
 * notebook's sections render as colored folder tabs; the active tab merges into
 * the page's colored top frame. The left end carries the notebook label, which
 * doubles as the nav show/hide toggle; a trailing "+" adds a section.
 *
 * Sections are reachable from both here and the left nav (intentional, matching
 * OneNote), so both share buildSectionMenu / colorSubmenu from ./sectionMenu.
 */

import { useState } from "react";
import { Icon } from "../ui/Icon";
import { EditableLabel } from "../ui/EditableLabel";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { useVellum } from "../../state/vellum";
import { DEFAULT_NOTEBOOK_COLOR, DEFAULT_SECTION_COLOR } from "../../data/palette";
import { buildSectionMenu } from "./sectionMenu";
import { reorderByDrop } from "../dnd";
import "./SectionTabs.css";

interface SectionTabsProps {
  navCollapsed: boolean;
  onToggleNav: () => void;
  onOpenSectionProperties: (notebookId: string, sectionId: string) => void;
}

export function SectionTabs({
  navCollapsed,
  onToggleNav,
  onOpenSectionProperties,
}: SectionTabsProps) {
  const { notebooks, selectedNotebookId, selectedSectionId, actions } = useVellum();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const notebook = notebooks.find((n) => n.id === selectedNotebookId) ?? null;
  const sections = notebook?.sections ?? [];

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onDrop = (targetId: string) => {
    if (!notebook || !dragId || dragId === targetId) return;
    const order = reorderByDrop(sections.map((s) => s.id), dragId, targetId);
    actions.reorderSections(notebook.id, order);
  };

  return (
    <div className="v-sectiontabs">
      <button
        type="button"
        className="v-sectiontabs__notebook"
        title={navCollapsed ? "Show notebooks" : "Hide notebooks"}
        aria-label={navCollapsed ? "Show notebooks" : "Hide notebooks"}
        aria-expanded={!navCollapsed}
        onClick={onToggleNav}
        style={{ ["--nb-color" as string]: notebook?.color ?? DEFAULT_NOTEBOOK_COLOR }}
      >
        <Icon name="book" />
        <span className="v-sectiontabs__notebook-name">
          {notebook?.name ?? "No notebook"}
        </span>
      </button>

      <div className="v-sectiontabs__tabs" role="tablist">
        {sections.map((s) => {
          const selected = s.id === selectedSectionId;
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={selected}
              className={[
                "v-sectiontabs__tab",
                selected ? "v-sectiontabs__tab--selected" : "",
              ].join(" ")}
              style={{ ["--tab-color" as string]: s.color ?? DEFAULT_SECTION_COLOR }}
              draggable={editingId !== s.id}
              onDragStart={() => setDragId(s.id)}
              onDragOver={(e) => dragId && e.preventDefault()}
              onDrop={() => onDrop(s.id)}
              onDragEnd={() => setDragId(null)}
              onClick={() => notebook && actions.selectSection(notebook.id, s.id)}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  setEditingId(s.id);
                }
              }}
              tabIndex={0}
              onContextMenu={(e) =>
                notebook &&
                openMenu(
                  e,
                  buildSectionMenu({
                    notebookId: notebook.id,
                    section: s,
                    actions,
                    onRename: () => setEditingId(s.id),
                    onOpenProperties: () => onOpenSectionProperties(notebook.id, s.id),
                  }),
                )
              }
            >
              <EditableLabel
                className="v-sectiontabs__tab-label"
                value={s.name}
                editing={editingId === s.id}
                onCommit={(name) => {
                  if (notebook) actions.renameSection(notebook.id, s.id, name);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </div>
          );
        })}

        {notebook && (
          <button
            type="button"
            className="v-sectiontabs__add"
            title="New section"
            aria-label="New section"
            onClick={async () => {
              const sec = await actions.createSection(notebook.id, "New Section");
              if (sec) {
                await actions.selectSection(notebook.id, sec.id);
                setEditingId(sec.id);
              }
            }}
          >
            <Icon name="plus-small" />
          </button>
        )}
      </div>

      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
