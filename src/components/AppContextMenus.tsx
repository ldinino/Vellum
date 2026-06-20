/**
 * App-wide right-click handling (spec Section 5 / Phase 8 prerequisite).
 *
 * A single capture-phase listener suppresses the native WebView2 context menu
 * everywhere — it doesn't match the retro theme, and spelling suggestions are
 * now sourced from Harper rather than the native menu. Components that have
 * their own themed menus (the editor body, nav/page/section/attachment items)
 * still show them; this only adds a themed Cut/Copy/Paste/Select All menu for
 * plain text inputs and textareas (page title, search box, settings, dialogs),
 * which would otherwise have no right-click menu at all.
 */

import { useEffect, useState } from "react";
import { ContextMenu, MenuItem } from "./ui/ContextMenu";
import { readClipboard, execClipboard } from "../lib/clipboard";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Input types with no editable text selection — skip the clipboard menu. */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "button",
  "submit",
  "reset",
  "image",
  "hidden",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

function isTextField(el: Element | null): el is TextField {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  return false;
}

async function pasteIntoField(field: TextField) {
  const { text } = await readClipboard();
  if (!text) return;
  field.focus();
  // insertText replaces the current selection and fires the input event React
  // listens to, so controlled inputs update correctly.
  document.execCommand("insertText", false, text);
}

function fieldMenuItems(field: TextField): MenuItem[] {
  const hasSel =
    field.selectionStart != null && field.selectionStart !== field.selectionEnd;
  const readOnly = field.readOnly || field.disabled;
  return [
    {
      label: "Cut",
      icon: "scissors",
      disabled: !hasSel || readOnly,
      onSelect: () => execClipboard("cut"),
    },
    {
      label: "Copy",
      icon: "documents-stack",
      disabled: !hasSel,
      onSelect: () => execClipboard("copy"),
    },
    {
      label: "Paste",
      icon: "clipboard-paste",
      disabled: readOnly,
      onSelect: () => void pasteIntoField(field),
      separatorAfter: true,
    },
    {
      label: "Select All",
      onSelect: () => {
        field.focus();
        field.select();
      },
    },
  ];
}

export function AppContextMenus() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      // Kill the native menu everywhere (capture phase, before any handler).
      e.preventDefault();
      const target = e.target as HTMLElement | null;
      const field = target?.closest?.("input, textarea") ?? null;
      // The editor body shows its own menu; only plain text fields need one here.
      if (!isTextField(field) || field.closest(".v-prose")) {
        setMenu(null);
        return;
      }
      field.focus();
      setMenu({ x: e.clientX, y: e.clientY, items: fieldMenuItems(field) });
    };
    document.addEventListener("contextmenu", onContext, true);
    return () => document.removeEventListener("contextmenu", onContext, true);
  }, []);

  if (!menu) return null;
  return <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />;
}
