/**
 * Shared builders for the section context menu and the "Change color" submenu.
 * Used by both the left nav (NavPanel) and the top section tabs (SectionTabs)
 * so the two entry points to a section never drift apart.
 */

import { ask } from "@tauri-apps/plugin-dialog";
import { PALETTE } from "../../data/palette";
import type { MenuItem } from "../ui/ContextMenu";
import type { Section } from "../../data/types";
import type { VellumActions } from "../../state/vellum";

/** Color picker submenu: a swatch per palette entry plus "None". */
export function colorSubmenu(
  current: string | null,
  apply: (color: string | null) => void,
): MenuItem[] {
  return [
    ...PALETTE.map((c) => ({
      label: c.name,
      swatch: c.value,
      checked: current === c.value,
      onSelect: () => apply(c.value),
    })),
    { label: "None", onSelect: () => apply(null) },
  ];
}

export interface SectionMenuDeps {
  notebookId: string;
  section: Section;
  actions: VellumActions;
  /** Start inline rename of the section label. */
  onRename: () => void;
  onOpenProperties: () => void;
}

export function buildSectionMenu({
  notebookId,
  section,
  actions,
  onRename,
  onOpenProperties,
}: SectionMenuDeps): MenuItem[] {
  const { id, name, color, pageTemplateId } = section;
  return [
    {
      label: "Add Page",
      icon: "document--plus",
      onSelect: () => actions.createPage(notebookId, id),
    },
    { label: "Rename", icon: "card--pencil", onSelect: onRename },
    {
      label: "Change color",
      icon: "edit-color",
      // Preserve the section's page-template assignment — update_section writes
      // every column, so passing null here would silently clear it.
      submenu: colorSubmenu(color, (c) =>
        actions.updateSection(notebookId, id, name, c, pageTemplateId),
      ),
    },
    {
      label: "Properties…",
      icon: "gear",
      onSelect: onOpenProperties,
      separatorAfter: true,
    },
    {
      label: "Delete Section",
      icon: "cross",
      danger: true,
      onSelect: async () => {
        const ok = await ask(
          `Delete section "${name}" and all its pages? This cannot be undone.`,
          { title: "Delete Section", kind: "warning" },
        );
        if (ok) actions.deleteSection(notebookId, id);
      },
    },
  ];
}
