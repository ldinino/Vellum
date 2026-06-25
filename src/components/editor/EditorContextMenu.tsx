/**
 * Unified right-click menu for the editor body (spec Section 5 / Phase 8
 * prerequisite). One `contextmenu` listener on the ProseMirror DOM replaces the
 * native WebView2 menu with our themed `ContextMenu`, choosing items by what's
 * under the cursor:
 *
 *   1. spelling error   → suggestions · Ignore
 *   2. grammar error    → suggestions · Ignore · Ignore Rule
 *   3. link             → Open / Edit… / Remove (+ clipboard)
 *   4. selection/caret  → Cut / Copy / Paste (· Refine seam ·) Select All
 *
 * Refine (Phase 8) plugs in via `buildRefineItems`: when supplied and there's a
 * selection, its items are inserted into the selection menu. Until then the seam
 * is simply absent.
 *
 * Grammar/spelling accept + ignore reuse the same helpers as the hover tooltip
 * ([GrammarPopover]); `onAfterAction` re-runs the linter so underlines refresh.
 */

import { useEffect, useRef, useState } from "react";
import { Editor, getMarkRange } from "@tiptap/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ContextMenu, MenuItem } from "../ui/ContextMenu";
import { grammarHitAt, GrammarHit, suggestionLabel } from "./GrammarError";
import { ignoreInstance, ignoreRule } from "./grammar";
import { readClipboard, execClipboard } from "../../lib/clipboard";
import { requestOpenFind } from "./find";
import { LinkDialog } from "./LinkDialog";

interface Props {
  editor: Editor | null;
  /** Re-run the linter after an accept/ignore so underlines refresh. */
  onAfterAction: () => void;
  /**
   * Phase 8 seam: given the current selection's text, return Refine menu items
   * ("Refine…" for one template, "Refine ▶" submenu for several). Inserted into
   * the selection menu when present; omitted entirely until Phase 8 supplies it.
   */
  buildRefineItems?: (selectedText: string) => MenuItem[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

async function pasteIntoEditor(editor: Editor) {
  const { html, text } = await readClipboard();
  editor.view.focus();
  if (html) editor.view.pasteHTML(html);
  else if (text) editor.view.pasteText(text);
}

/** Cut / Copy / Paste; Cut/Copy disable without a selection. */
function clipboardItems(editor: Editor): MenuItem[] {
  const hasSel = !editor.state.selection.empty;
  return [
    { label: "Cut", icon: "scissors", disabled: !hasSel, onSelect: () => execClipboard("cut") },
    {
      label: "Copy",
      icon: "documents-stack",
      disabled: !hasSel,
      onSelect: () => execClipboard("copy"),
    },
    { label: "Paste", icon: "clipboard-paste", onSelect: () => void pasteIntoEditor(editor) },
  ];
}

/** Suggestions + Ignore (+ Ignore Rule for grammar). */
function lintItems(editor: Editor, hit: GrammarHit, onAfter: () => void): MenuItem[] {
  const items: MenuItem[] = [];
  if (hit.suggestions.length === 0) {
    items.push({ label: "No suggestions", disabled: true });
  } else {
    for (const s of hit.suggestions.slice(0, 6)) {
      items.push({
        label: suggestionLabel(s),
        onSelect: () => {
          const chain = editor.chain().focus();
          if (s === "") chain.deleteRange({ from: hit.from, to: hit.to }).run();
          else chain.insertContentAt({ from: hit.from, to: hit.to }, s).run();
          onAfter();
        },
      });
    }
  }
  items[items.length - 1].separatorAfter = true;
  items.push({
    label: "Ignore",
    icon: "cross-small",
    onSelect: () => {
      ignoreInstance(hit.instanceKey);
      onAfter();
    },
  });
  if (!hit.isSpelling) {
    items.push({
      label: "Ignore Rule",
      icon: "eraser",
      onSelect: () => {
        ignoreRule(hit.kind);
        onAfter();
      },
    });
  }
  return items;
}

/** Open / Edit / Remove for a link under the cursor. */
function linkItems(
  editor: Editor,
  href: string,
  pos: number,
  onEdit: (pos: number, href: string) => void,
): MenuItem[] {
  return [
    { label: "Open Link", icon: "chain", onSelect: () => void openUrl(href) },
    { label: "Edit Link…", icon: "chain--plus", onSelect: () => onEdit(pos, href) },
    {
      label: "Remove Link",
      icon: "chain--minus",
      onSelect: () =>
        editor.chain().focus().setTextSelection(pos).extendMarkRange("link").unsetLink().run(),
      separatorAfter: true,
    },
  ];
}

function buildMenu(
  editor: Editor,
  e: MouseEvent,
  onAfter: () => void,
  onEdit: (pos: number, href: string) => void,
  buildRefine?: (text: string) => MenuItem[],
): MenuItem[] {
  const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
  const pos = at?.pos ?? editor.state.selection.from;

  // 1. grammar / spelling underline under the cursor
  const hit = at ? grammarHitAt(editor, at.pos) : null;
  if (hit) return lintItems(editor, hit, onAfter);

  // 2. link under the cursor — link actions, then clipboard
  const a = (e.target as HTMLElement)?.closest?.("a");
  const href = a?.getAttribute("href");
  if (href) return [...linkItems(editor, href, pos, onEdit), ...clipboardItems(editor)];

  // 3. selection / caret — clipboard, optional Refine seam, Select All
  const { selection, doc } = editor.state;
  const items = clipboardItems(editor);
  if (!selection.empty && buildRefine) {
    const refine = buildRefine(doc.textBetween(selection.from, selection.to, " "));
    if (refine.length) {
      items[items.length - 1].separatorAfter = true;
      items.push(...refine);
    }
  }
  items[items.length - 1].separatorAfter = true;
  items.push({
    label: "Select All",
    icon: "ui-text-field-select",
    onSelect: () => editor.chain().focus().selectAll().run(),
  });
  items.push({ label: "Find", icon: "magnifier", onSelect: requestOpenFind });
  return items;
}

export function EditorContextMenu({ editor, onAfterAction, buildRefineItems }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editLink, setEditLink] = useState<{ pos: number; href: string; text: string } | null>(
    null,
  );

  // Refs keep the listener (registered once per editor) reading current props.
  const onAfterRef = useRef(onAfterAction);
  onAfterRef.current = onAfterAction;
  const buildRefineRef = useRef(buildRefineItems);
  buildRefineRef.current = buildRefineItems;

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const items = buildMenu(
        editor,
        e,
        () => onAfterRef.current(),
        (pos, href) => {
          // Capture the link's current visible text so the dialog can edit the
          // label, not just the address.
          const range = getMarkRange(editor.state.doc.resolve(pos), editor.schema.marks.link);
          const text = range ? editor.state.doc.textBetween(range.from, range.to) : "";
          setEditLink({ pos, href, text });
        },
        buildRefineRef.current,
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    dom.addEventListener("contextmenu", onContext);
    return () => dom.removeEventListener("contextmenu", onContext);
  }, [editor]);

  if (!editor) return null;

  const applyLink = (href: string, text: string) => {
    if (!editLink) return;
    const range = getMarkRange(editor.state.doc.resolve(editLink.pos), editor.schema.marks.link);
    if (!range) {
      setEditLink(null);
      return;
    }
    // Empty address → drop the link entirely (keep the text in place).
    if (!href) {
      editor.chain().focus().setTextSelection(range).extendMarkRange("link").unsetLink().run();
      setEditLink(null);
      return;
    }
    const label = text.trim() || href;
    const current = editor.state.doc.textBetween(range.from, range.to);
    const chain = editor.chain().focus();
    if (label !== current) {
      // Rewrite the label, carrying the (possibly new) address on the new text.
      chain.insertContentAt(range, {
        type: "text",
        text: label,
        marks: [{ type: "link", attrs: { href } }],
      });
    } else {
      // Label unchanged — just update the address across the whole link.
      chain.setTextSelection(range).extendMarkRange("link").setLink({ href });
    }
    chain.run();
    setEditLink(null);
  };

  return (
    <>
      {menu && (
        <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
      {editLink && (
        <LinkDialog
          title="Edit Link"
          initialHref={editLink.href}
          initialText={editLink.text}
          onSubmit={applyLink}
          onCancel={() => setEditLink(null)}
        />
      )}
    </>
  );
}
