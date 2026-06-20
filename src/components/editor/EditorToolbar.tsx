import { useEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../ui/Toolbar";
import { Icon } from "../ui/Icon";
import { useActiveEditor } from "../../state/activeEditor";
import { SearchBox } from "../search/SearchBar";
import "./EditorToolbar.css";

const FONTS = [
  "Segoe UI",
  "Calibri",
  "Cambria",
  "Georgia",
  "Times New Roman",
  "Arial",
  "Verdana",
  "Consolas",
  "Comic Sans MS",
];
const SIZES = ["10", "11", "12", "14", "16", "18", "24", "36"];

interface FormattingGroupsProps {
  editor: Editor | null;
  insertImage: (file: File) => void;
  linkOpen: boolean;
  setLinkOpen: (v: boolean) => void;
}

/**
 * The formatting controls themselves, rendered as flex children of a toolbar
 * bar. Tolerates a null editor (renders everything disabled) so the shell-level
 * TopToolbar stays visible when no page is open.
 */
function FormattingGroups({ editor, insertImage, setLinkOpen }: FormattingGroupsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        } as Record<1 | 2 | 3 | 4, boolean>,
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
        blockquote: editor.isActive("blockquote"),
        codeBlock: editor.isActive("codeBlock"),
        link: editor.isActive("link"),
      };
    },
  });

  const disabled = !editor || !s;
  const colorClass = `v-editortoolbar__color${disabled ? " is-disabled" : ""}`;

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
        {([1, 2, 3, 4] as const).map((level) => (
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
          value={s?.fontFamily ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor?.chain().focus().setFontFamily(v).run();
            else editor?.chain().focus().unsetFontFamily().run();
          }}
        >
          <option value="">Font</option>
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <select
          className="v-editortoolbar__select v-editortoolbar__select--size"
          title="Font size"
          value={s?.fontSize ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v) editor?.chain().focus().setFontSize(`${v}px`).run();
            else editor?.chain().focus().unsetFontSize().run();
          }}
        >
          <option value="">Size</option>
          {SIZES.map((size) => (
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
          label="Link"
          active={s?.link}
          disabled={disabled}
          onClick={() => setLinkOpen(true)}
        />
      </ToolbarGroup>

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
}: {
  editor: Editor | null;
  onInsertImage: (file: File) => void;
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
        />
      </Toolbar>
      {linkOpen && editor && <LinkEditor editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

/**
 * Unified, persistent top toolbar (OneNote 2007): formatting on the left,
 * compact search + settings at the right. Operates on the active page editor
 * shared up via ActiveEditorProvider; controls disable when no page is open.
 */
export function TopToolbar({ onOpenSettings }: { onOpenSettings: () => void }) {
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
        <div className="v-toptoolbar__right">
          <SearchBox />
          <button
            type="button"
            className="v-toptoolbar__gear"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Icon name="gear" />
          </button>
        </div>
      </div>
      {linkOpen && editor && <LinkEditor editor={editor} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

function LinkEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [href, setHref] = useState<string>(editor.getAttributes("link").href ?? "https://");

  const apply = () => {
    const url = href.trim();
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    onClose();
  };

  return (
    <div className="v-linkeditor">
      <input
        autoFocus
        type="url"
        value={href}
        placeholder="https://example.com"
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <button type="button" onClick={apply}>
        Apply
      </button>
      <button
        type="button"
        onClick={() => {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          onClose();
        }}
      >
        Remove
      </button>
    </div>
  );
}
