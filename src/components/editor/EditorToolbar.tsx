import { useEffect, useMemo, useRef, useState } from "react";
import { useEditorState, getMarkRange } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../ui/Toolbar";
import { useActiveEditor } from "../../state/activeEditor";
import { useVellum } from "../../state/vellum";
import { FONTS, SIZES } from "../../data/fonts";
import { LinkDialog } from "./LinkDialog";
import { ProofingBadge } from "./ProofingBadge";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import {
  DYNAMIC_FIELD_PRESETS,
  formatDynamicField,
  type DynamicFieldKind,
} from "../../lib/dynamic-fields";
import "./EditorToolbar.css";

interface FormattingGroupsProps {
  editor: Editor | null;
  insertImage: (file: File) => void;
  linkOpen: boolean;
  setLinkOpen: (v: boolean) => void;
  /** Show the template-only "Insert placeholder" dropdown (page templates). */
  showPlaceholders?: boolean;
}

/**
 * The formatting controls themselves, rendered as flex children of a toolbar
 * bar. Tolerates a null editor (renders everything disabled) so the shell-level
 * TopToolbar stays visible when no page is open.
 */
function FormattingGroups({
  editor,
  insertImage,
  setLinkOpen,
  showPlaceholders,
}: FormattingGroupsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The editor's configured default font/size (Settings → Editor) is what
  // unstyled text renders at, so the selects fall back to it instead of a blank
  // placeholder — and stay accurate when the user changes the default.
  const { defaultFont, defaultFontSize } = useVellum();
  const [phMenu, setPhMenu] = useState<{ x: number; y: number } | null>(null);

  // "Insert placeholder" dropdown (template editor only): one-shot tokens go in
  // as literal text (the backend substitutes them when a page is created from the
  // template); live fields go in as a `dynamicField` node that re-evaluates on
  // every page load.
  const insertText = (text: string) => editor?.chain().focus().insertContent(text).run();
  const insertField = (kind: DynamicFieldKind, format: string) =>
    editor?.chain().focus().insertDynamicField(kind, format).run();
  const placeholderItems = (): MenuItem[] => {
    const now = new Date();
    const liveSub = (kind: DynamicFieldKind): MenuItem[] =>
      DYNAMIC_FIELD_PRESETS[kind].map((p) => ({
        label: formatDynamicField(kind, p.key, now),
        onSelect: () => insertField(kind, p.key),
      }));
    return [
      { label: "Page title", icon: "document", onSelect: () => insertText("{{PageTitle}}") },
      { label: "Section name", icon: "folder", onSelect: () => insertText("{{SectionName}}") },
      {
        label: "Notebook name",
        icon: "book",
        onSelect: () => insertText("{{NotebookName}}"),
        separatorAfter: true,
      },
      { label: "Current date", icon: "calendar", onSelect: () => insertText("{{CurrentDate}}") },
      { label: "Current time", icon: "clock", onSelect: () => insertText("{{CurrentTime}}") },
      {
        label: "Current date & time",
        icon: "calendar",
        onSelect: () => insertText("{{CurrentDateTime}}"),
        separatorAfter: true,
      },
      { label: "Live date", icon: "calendar", submenu: liveSub("date") },
      { label: "Live time", icon: "clock", submenu: liveSub("time") },
      { label: "Live date & time", icon: "calendar", submenu: liveSub("datetime") },
    ];
  };

  // Tiptap v3's `useEditor` no longer re-renders on every transaction, so the
  // toolbar must subscribe explicitly to keep active states / select values in
  // sync with the caret. Returns null when there is no editor.
  const s = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor) return null;
      const style = editor.getAttributes("textStyle");
      return {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        headings: {
          1: editor.isActive("heading", { level: 1 }),
          2: editor.isActive("heading", { level: 2 }),
          3: editor.isActive("heading", { level: 3 }),
          4: editor.isActive("heading", { level: 4 }),
          5: editor.isActive("heading", { level: 5 }),
          6: editor.isActive("heading", { level: 6 }),
        } as Record<1 | 2 | 3 | 4 | 5 | 6, boolean>,
        fontFamily: (style.fontFamily as string | undefined) ?? "",
        fontSize: ((style.fontSize as string | undefined) ?? "").replace("px", ""),
        color: (style.color as string | undefined) ?? "#000000",
        highlight: (editor.getAttributes("highlight").color as string | undefined) ?? "#ffe600",
        alignLeft: editor.isActive({ textAlign: "left" }),
        alignCenter: editor.isActive({ textAlign: "center" }),
        alignRight: editor.isActive({ textAlign: "right" }),
        alignJustify: editor.isActive({ textAlign: "justify" }),
        superscript: editor.isActive("superscript"),
        subscript: editor.isActive("subscript"),
        bulletList: editor.isActive("bulletList"),
        orderedList: editor.isActive("orderedList"),
        taskList: editor.isActive("taskList"),
        blockquote: editor.isActive("blockquote"),
        codeBlock: editor.isActive("codeBlock"),
        link: editor.isActive("link"),
      };
    },
  });

  const disabled = !editor || !s;
  const colorClass = `v-editortoolbar__color${disabled ? " is-disabled" : ""}`;

  // Show the effective font/size: the caret's textStyle mark if any, otherwise
  // the document default (so unstyled text reads as "Segoe UI 14", not blank).
  // An out-of-list value (e.g. from pasted content) is added as an option so the
  // box never goes unexpectedly empty.
  const displayFont = disabled ? "" : s?.fontFamily || defaultFont;
  const displaySize = disabled ? "" : s?.fontSize || String(defaultFontSize);
  const fontOptions =
    displayFont && !FONTS.includes(displayFont) ? [displayFont, ...FONTS] : FONTS;
  const sizeOptions =
    displaySize && !SIZES.includes(displaySize) ? [displaySize, ...SIZES] : SIZES;

  return (
    <>
      <ToolbarGroup>
        <ToolbarButton
          icon="edit-bold"
          label="Bold (Ctrl+B)"
          active={s?.bold}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          icon="edit-italic"
          label="Italic (Ctrl+I)"
          active={s?.italic}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        />
        <ToolbarButton
          icon="edit-underline"
          label="Underline (Ctrl+U)"
          active={s?.underline}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        />
        <ToolbarButton
          icon="edit-strike"
          label="Strikethrough"
          active={s?.strike}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        {([1, 2, 3, 4, 5, 6] as const).map((level) => (
          <ToolbarButton
            key={level}
            icon={`edit-heading-${level}`}
            label={`Heading ${level}`}
            active={s?.headings[level]}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleHeading({ level }).run()}
          />
        ))}
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <select
          className="v-editortoolbar__select"
          title="Font"
          value={displayFont}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor?.chain().focus().setFontFamily(v).run();
            else editor?.chain().focus().unsetFontFamily().run();
          }}
        >
          <option value="">Font</option>
          {fontOptions.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <select
          className="v-editortoolbar__select v-editortoolbar__select--size"
          title="Font size"
          value={displaySize}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor?.chain().focus().setFontSize(`${v}px`).run();
            else editor?.chain().focus().unsetFontSize().run();
          }}
        >
          <option value="">Size</option>
          {sizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <label className={colorClass} title="Text color">
          <span style={{ color: s?.color ?? "#000000" }}>A</span>
          <input
            type="color"
            value={s?.color ?? "#000000"}
            disabled={disabled}
            onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()}
          />
        </label>
        <label className={`${colorClass} v-editortoolbar__color--hl`} title="Highlight">
          <span style={{ background: s?.highlight ?? "#ffe600" }} />
          <input
            type="color"
            value={s?.highlight ?? "#ffe600"}
            disabled={disabled}
            onChange={(e) => editor?.chain().focus().setHighlight({ color: e.target.value }).run()}
          />
        </label>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ToolbarButton
          icon="edit-alignment"
          label="Align left"
          active={s?.alignLeft}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign("left").run()}
        />
        <ToolbarButton
          icon="edit-alignment-center"
          label="Align center"
          active={s?.alignCenter}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign("center").run()}
        />
        <ToolbarButton
          icon="edit-alignment-right"
          label="Align right"
          active={s?.alignRight}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign("right").run()}
        />
        <ToolbarButton
          icon="edit-alignment-justify"
          label="Justify"
          active={s?.alignJustify}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign("justify").run()}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ToolbarButton
          icon="edit-superscript"
          label="Superscript"
          active={s?.superscript}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleSuperscript().run()}
        />
        <ToolbarButton
          icon="edit-subscript"
          label="Subscript"
          active={s?.subscript}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleSubscript().run()}
        />
        <ToolbarButton
          icon="eraser"
          label="Clear formatting"
          disabled={disabled}
          onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ToolbarButton
          icon="edit-list"
          label="Bullet list"
          active={s?.bulletList}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        />
        <ToolbarButton
          icon="edit-list-order"
          label="Numbered list"
          active={s?.orderedList}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        />
        <ToolbarButton
          icon="ui-check-boxes-list"
          label="Task list"
          active={s?.taskList}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        />
        <ToolbarButton
          icon="edit-quotation"
          label="Blockquote"
          active={s?.blockquote}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        />
        <ToolbarButton
          icon="edit-code"
          label="Code block"
          active={s?.codeBlock}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        />
        <ToolbarButton
          icon="sitemap"
          label="Mermaid diagram"
          disabled={disabled}
          onClick={() => editor?.chain().focus().insertMermaidDiagram().run()}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ToolbarButton
          icon="image--plus"
          label="Insert image"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        />
        <ToolbarButton
          icon="chain"
          label="Insert link"
          active={s?.link}
          disabled={disabled}
          onClick={() => setLinkOpen(true)}
        />
      </ToolbarGroup>

      {showPlaceholders && (
        <>
          <ToolbarSeparator />
          <ToolbarGroup>
            <ToolbarButton
              icon="tag"
              label="Insert placeholder"
              disabled={disabled}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPhMenu({ x: r.left, y: r.bottom });
              }}
            />
          </ToolbarGroup>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) insertImage(f);
          e.target.value = "";
        }}
      />
      {phMenu && (
        <ContextMenu
          items={placeholderItems()}
          x={phMenu.x}
          y={phMenu.y}
          onClose={() => setPhMenu(null)}
        />
      )}
    </>
  );
}

/**
 * Self-contained formatting toolbar with its own editor (used by the page
 * template editor). The main page editor uses TopToolbar instead.
 */
export function EditorToolbar({
  editor,
  onInsertImage,
  showPlaceholders,
}: {
  editor: Editor | null;
  onInsertImage: (file: File) => void;
  showPlaceholders?: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <div className="v-editortoolbar">
      <Toolbar>
        <FormattingGroups
          editor={editor}
          insertImage={onInsertImage}
          linkOpen={linkOpen}
          setLinkOpen={setLinkOpen}
          showPlaceholders={showPlaceholders}
        />
      </Toolbar>
      {linkOpen && editor && <ToolbarLinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

/**
 * Persistent top formatting toolbar (OneNote 2007). Operates on the active page
 * editor shared up via ActiveEditorProvider; controls disable when no page is
 * open. (Search lives in the tab row below — see VellumShell.)
 */
export function TopToolbar() {
  const { active } = useActiveEditor();
  const editor = active?.editor ?? null;
  const insertImage = active?.insertImage ?? (() => {});
  const [linkOpen, setLinkOpen] = useState(false);

  // Drop a stale open link editor when the page (and its editor) changes.
  useEffect(() => {
    setLinkOpen(false);
  }, [editor]);

  return (
    <div className="v-toptoolbar">
      <div className="v-toolbar v-toptoolbar__bar" role="toolbar">
        <div className="v-toptoolbar__format">
          <FormattingGroups
            editor={editor}
            insertImage={insertImage}
            linkOpen={linkOpen}
            setLinkOpen={setLinkOpen}
          />
        </div>
        <ProofingBadge />
      </div>
      {linkOpen && editor && <ToolbarLinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

/** Resolve what a toolbar "Insert link" click should act on: an existing link
 * under the caret (edit it), a non-empty selection (link the selected text), or
 * a bare caret (insert a brand-new link). Captured once when the dialog opens. */
function resolveLinkTarget(editor: Editor): {
  range: { from: number; to: number } | null;
  href: string;
  text: string;
} {
  const { from, to } = editor.state.selection;
  const linkRange = getMarkRange(editor.state.doc.resolve(from), editor.schema.marks.link);
  if (linkRange) {
    return {
      range: linkRange,
      href: editor.getAttributes("link").href ?? "",
      text: editor.state.doc.textBetween(linkRange.from, linkRange.to),
    };
  }
  if (from !== to) {
    return { range: { from, to }, href: "", text: editor.state.doc.textBetween(from, to, " ") };
  }
  return { range: null, href: "", text: "" };
}

/** Apply the dialog result: edit the link over `range`, or insert a new one at
 * the caret when `range` is null. An empty address removes an existing link. */
function applyLinkEdit(
  editor: Editor,
  range: { from: number; to: number } | null,
  href: string,
  text: string,
): void {
  const url = href.trim();
  const label = text.trim();
  if (range) {
    if (!url) {
      editor.chain().focus().setTextSelection(range).extendMarkRange("link").unsetLink().run();
      return;
    }
    const finalLabel = label || url;
    const current = editor.state.doc.textBetween(range.from, range.to);
    if (finalLabel !== current) {
      editor
        .chain()
        .focus()
        .insertContentAt(range, {
          type: "text",
          text: finalLabel,
          marks: [{ type: "link", attrs: { href: url } }],
        })
        .run();
    } else {
      editor
        .chain()
        .focus()
        .setTextSelection(range)
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
    }
  } else {
    if (!url) return;
    const finalLabel = label || url;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: finalLabel,
        marks: [{ type: "link", attrs: { href: url } }],
      })
      .run();
  }
}

/** Toolbar "Insert link": opens the shared [LinkDialog] pre-filled from the
 * selection/caret, then applies the result. */
function ToolbarLinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const target = useMemo(() => resolveLinkTarget(editor), [editor]);
  return (
    <LinkDialog
      title={target.href ? "Edit Link" : "Insert Link"}
      initialHref={target.href}
      initialText={target.text}
      onSubmit={(href, text) => {
        applyLinkEdit(editor, target.range, href, text);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
