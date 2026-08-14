/**
 * Shared builders for the section context menu and the "Change color" submenu.
 * Used by both the left nav (NavPanel) and the top section tabs (SectionTabs)
 * so the two entry points to a section never drift apart.
 */

import { PALETTE } from "../../data/palette";
import type { MenuItem } from "../ui/ContextMenu";
import type { Section } from "../../data/types";
import type { VellumActions } from "../../state/vellum";

/** Color picker submenu: a swatch per palette entry. */
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
  ];
}

export interface SectionMenuDeps {
  notebookId: string;
  section: Section;
  actions: VellumActions;
  /** Start inline rename of the section label. */
  onRename: () => void;
  onOpenProperties: () => void;
  /** Another device has the Satchel: nothing here may change it (docs 5.7). */
  readOnly?: boolean;
}

export function buildSectionMenu({
  notebookId,
  section,
  actions,
  onRename,
  onOpenProperties,
  readOnly = false,
}: SectionMenuDeps): MenuItem[] {
  const { id, name, color, pageTemplateId } = section;
  return [
    {
      label: "Add Page",
      icon: "document--plus",
      disabled: readOnly,
      onSelect: () => actions.createPage(notebookId, id),
    },
    { label: "Rename", icon: "card--pencil", disabled: readOnly, onSelect: onRename },
    {
      label: "Change color",
      icon: "edit-color",
      disabled: readOnly,
      // Preserve the section's page-template assignment — update_section writes
      // every column, so passing null here would silently clear it.
      submenu: colorSubmenu(color, (c) =>
        actions.updateSection(notebookId, id, name, c, pageTemplateId),
      ),
    },
    {
      label: "Properties…",
      icon: "gear",
      disabled: readOnly,
      onSelect: onOpenProperties,
      separatorAfter: true,
    },
    {
      label: "Delete Section",
      icon: "cross",
      danger: true,
      disabled: readOnly,
      // Recoverable via the Recycle Bin (spec Section 5.1) — no confirmation.
      onSelect: () => actions.deleteSection(notebookId, id),
    },
  ];
}
