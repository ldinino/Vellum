/**
 * OneNote 2007-style menu bar (File / Edit / Insert / Tools), sitting above the
 * toolbar. Keeps the toolbar uncluttered by housing the less-frequent actions
 * (table editing, horizontal rule, grammar toggle, window/file commands) in
 * dropdowns. Reuses ContextMenu for the dropdowns; items are rebuilt each render
 * so their enabled/checked state reflects the current editor + selection.
 */

import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ContextMenu, MenuItem } from "./ui/ContextMenu";
import { useActiveEditor } from "../state/activeEditor";
import { useVellum } from "../state/vellum";
import "./MenuBar.css";

const inTauri = "__TAURI_INTERNALS__" in window;

export function MenuBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { active } = useActiveEditor();
  const editor = active?.editor ?? null;
  const { actions, grammarEnabled, selectedNotebookId, selectedSectionId } = useVellum();
  const [open, setOpen] = useState<{ id: string; x: number; y: number } | null>(null);

  const openAt = (id: string, target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    setOpen({ id, x: r.left, y: r.bottom });
  };

  const fileItems = (): MenuItem[] => [
    {
      label: "New Notebook",
      icon: "book--plus",
      onSelect: async () => {
        const nb = await actions.createNotebook("New Notebook");
        if (nb) await actions.toggleNotebook(nb.id);
      },
    },
    {
      label: "New Section",
      icon: "folder--plus",
      disabled: !selectedNotebookId,
      onSelect: async () => {
        if (!selectedNotebookId) return;
        const s = await actions.createSection(selectedNotebookId, "New Section");
        if (s) await actions.selectSection(selectedNotebookId, s.id);
      },
    },
    {
      label: "New Page",
      icon: "document--plus",
      disabled: !selectedNotebookId || !selectedSectionId,
      onSelect: () => {
        if (selectedNotebookId && selectedSectionId) {
          actions.createPage(selectedNotebookId, selectedSectionId);
        }
      },
      separatorAfter: true,
    },
    {
      label: "Exit",
      disabled: !inTauri,
      onSelect: () => {
        if (inTauri) getCurrentWindow().close().catch(() => {});
      },
    },
  ];

  const editItems = (): MenuItem[] => [
    {
      label: "Undo",
      disabled: !editor?.can().undo(),
      onSelect: () => editor?.chain().focus().undo().run(),
    },
    {
      label: "Redo",
      disabled: !editor?.can().redo(),
      onSelect: () => editor?.chain().focus().redo().run(),
      separatorAfter: true,
    },
    {
      label: "Select All",
      disabled: !editor,
      onSelect: () => editor?.chain().focus().selectAll().run(),
    },
  ];

  const insertItems = (): MenuItem[] => [
    {
      label: "Table",
      icon: "table",
      submenu: [
        {
          label: "Insert Table",
          icon: "table",
          disabled: !editor,
          onSelect: () =>
            editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          separatorAfter: true,
        },
        {
          label: "Add Row Below",
          icon: "table-insert-row",
          disabled: !editor?.can().addRowAfter(),
          onSelect: () => editor?.chain().focus().addRowAfter().run(),
        },
        {
          label: "Delete Row",
          icon: "table-delete-row",
          disabled: !editor?.can().deleteRow(),
          onSelect: () => editor?.chain().focus().deleteRow().run(),
        },
        {
          label: "Add Column After",
          icon: "table-insert-column",
          disabled: !editor?.can().addColumnAfter(),
          onSelect: () => editor?.chain().focus().addColumnAfter().run(),
        },
        {
          label: "Delete Column",
          icon: "table-delete-column",
          disabled: !editor?.can().deleteColumn(),
          onSelect: () => editor?.chain().focus().deleteColumn().run(),
        },
      ],
    },
    {
      label: "Horizontal Rule",
      icon: "edit-rule",
      disabled: !editor,
      onSelect: () => editor?.chain().focus().setHorizontalRule().run(),
    },
  ];

  const toolsItems = (): MenuItem[] => [
    {
      // Toggle: the spell-check icon is always shown; when on, ContextMenu
      // highlights its icon box (and the label) to indicate the active state.
      label: "Check Grammar",
      icon: "spell-check",
      checked: grammarEnabled,
      onSelect: () => actions.setGrammarEnabled(!grammarEnabled),
      separatorAfter: true,
    },
    { label: "Settings…", icon: "gear", onSelect: onOpenSettings },
  ];

  const menus: { id: string; label: string; items: () => MenuItem[] }[] = [
    { id: "file", label: "File", items: fileItems },
    { id: "edit", label: "Edit", items: editItems },
    { id: "insert", label: "Insert", items: insertItems },
    { id: "tools", label: "Tools", items: toolsItems },
  ];

  return (
    <div className="v-menubar" role="menubar">
      {menus.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          className={`v-menubar__item${open?.id === m.id ? " is-open" : ""}`}
          // A click on an already-open menu lands outside ContextMenu, which
          // closes it; the onClick then toggles state to match.
          onClick={(e) =>
            open?.id === m.id ? setOpen(null) : openAt(m.id, e.currentTarget)
          }
          // Hovering another top menu while one is open switches to it.
          onMouseEnter={(e) => open && open.id !== m.id && openAt(m.id, e.currentTarget)}
        >
          {m.label}
        </button>
      ))}
      {open && (
        <ContextMenu
          items={menus.find((m) => m.id === open.id)!.items()}
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
