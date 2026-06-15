import { useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../ui/Toolbar";
import { useVellum } from "../../state/vellum";
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

interface EditorToolbarProps {
  editor: Editor | null;
  onInsertImage: (file: File) => void;
  /** Show the grammar on/off toggle (off in the template editor). */
  showGrammarToggle?: boolean;
}

export function EditorToolbar({
  editor,
  onInsertImage,
  showGrammarToggle = true,
}: EditorToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { grammarEnabled, actions } = useVellum();

  // Tiptap v3's `useEditor` no longer re-renders on every transaction, so the
  // toolbar must subscribe explicitly to keep active states / select values in
  // sync with the caret. The selector is deep-compared, so it only re-renders
  // when one of these derived values actually changes.
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
        canAddRow: editor.can().addRowAfter(),
        canDeleteRow: editor.can().deleteRow(),
        canAddColumn: editor.can().addColumnAfter(),
        canDeleteColumn: editor.can().deleteColumn(),
      };
    },
  });

  if (!editor || !s) return <Toolbar>{null}</Toolbar>;

  const run = (fn: () => void) => () => fn();

  return (
    <div className="v-editortoolbar">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton
            icon="edit-bold"
            label="Bold (Ctrl+B)"
            active={s.bold}
            onClick={run(() => editor.chain().focus().toggleBold().run())}
          />
          <ToolbarButton
            icon="edit-italic"
            label="Italic (Ctrl+I)"
            active={s.italic}
            onClick={run(() => editor.chain().focus().toggleItalic().run())}
          />
          <ToolbarButton
            icon="edit-underline"
            label="Underline (Ctrl+U)"
            active={s.underline}
            onClick={run(() => editor.chain().focus().toggleUnderline().run())}
          />
          <ToolbarButton
            icon="edit-strike"
            label="Strikethrough"
            active={s.strike}
            onClick={run(() => editor.chain().focus().toggleStrike().run())}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          {([1, 2, 3, 4] as const).map((level) => (
            <ToolbarButton
              key={level}
              icon={`edit-heading-${level}`}
              label={`Heading ${level}`}
              active={s.headings[level]}
              onClick={run(() => editor.chain().focus().toggleHeading({ level }).run())}
            />
          ))}
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <select
            className="v-editortoolbar__select"
            title="Font"
            value={s.fontFamily}
            onChange={(e) => {
              const v = e.target.value;
              if (v) editor.chain().focus().setFontFamily(v).run();
              else editor.chain().focus().unsetFontFamily().run();
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
            value={s.fontSize}
            onChange={(e) => {
              const v = e.target.value;
              if (v) editor.chain().focus().setFontSize(`${v}px`).run();
              else editor.chain().focus().unsetFontSize().run();
            }}
          >
            <option value="">Size</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="v-editortoolbar__color" title="Text color">
            <span style={{ color: s.color }}>A</span>
            <input
              type="color"
              value={s.color}
              onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            />
          </label>
          <label className="v-editortoolbar__color v-editortoolbar__color--hl" title="Highlight">
            <span style={{ background: s.highlight }} />
            <input
              type="color"
              value={s.highlight}
              onChange={(e) =>
                editor.chain().focus().setHighlight({ color: e.target.value }).run()
              }
            />
          </label>
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="edit-alignment"
            label="Align left"
            active={s.alignLeft}
            onClick={run(() => editor.chain().focus().setTextAlign("left").run())}
          />
          <ToolbarButton
            icon="edit-alignment-center"
            label="Align center"
            active={s.alignCenter}
            onClick={run(() => editor.chain().focus().setTextAlign("center").run())}
          />
          <ToolbarButton
            icon="edit-alignment-right"
            label="Align right"
            active={s.alignRight}
            onClick={run(() => editor.chain().focus().setTextAlign("right").run())}
          />
          <ToolbarButton
            icon="edit-alignment-justify"
            label="Justify"
            active={s.alignJustify}
            onClick={run(() => editor.chain().focus().setTextAlign("justify").run())}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="edit-superscript"
            label="Superscript"
            active={s.superscript}
            onClick={run(() => editor.chain().focus().toggleSuperscript().run())}
          />
          <ToolbarButton
            icon="edit-subscript"
            label="Subscript"
            active={s.subscript}
            onClick={run(() => editor.chain().focus().toggleSubscript().run())}
          />
          <ToolbarButton
            icon="eraser"
            label="Clear formatting"
            onClick={run(() => editor.chain().focus().unsetAllMarks().clearNodes().run())}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="edit-list"
            label="Bullet list"
            active={s.bulletList}
            onClick={run(() => editor.chain().focus().toggleBulletList().run())}
          />
          <ToolbarButton
            icon="edit-list-order"
            label="Numbered list"
            active={s.orderedList}
            onClick={run(() => editor.chain().focus().toggleOrderedList().run())}
          />
          <ToolbarButton
            icon="edit-quotation"
            label="Blockquote"
            active={s.blockquote}
            onClick={run(() => editor.chain().focus().toggleBlockquote().run())}
          />
          <ToolbarButton
            icon="edit-code"
            label="Code block"
            active={s.codeBlock}
            onClick={run(() => editor.chain().focus().toggleCodeBlock().run())}
          />
          <ToolbarButton
            icon="edit-rule"
            label="Horizontal rule"
            onClick={run(() => editor.chain().focus().setHorizontalRule().run())}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="table"
            label="Insert table"
            onClick={run(() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
            )}
          />
          <ToolbarButton icon="table-insert-row" label="Add row below" disabled={!s.canAddRow} onClick={run(() => editor.chain().focus().addRowAfter().run())} />
          <ToolbarButton icon="table-delete-row" label="Delete row" disabled={!s.canDeleteRow} onClick={run(() => editor.chain().focus().deleteRow().run())} />
          <ToolbarButton icon="table-insert-column" label="Add column after" disabled={!s.canAddColumn} onClick={run(() => editor.chain().focus().addColumnAfter().run())} />
          <ToolbarButton icon="table-delete-column" label="Delete column" disabled={!s.canDeleteColumn} onClick={run(() => editor.chain().focus().deleteColumn().run())} />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="image--plus"
            label="Insert image"
            onClick={() => fileInputRef.current?.click()}
          />
          <ToolbarButton
            icon="chain"
            label="Link"
            active={s.link}
            onClick={() => setLinkOpen((v) => !v)}
          />
        </ToolbarGroup>

        {showGrammarToggle && (
          <>
            <ToolbarSeparator />
            <ToolbarGroup>
              <ToolbarButton
                icon="spell-check"
                label={grammarEnabled ? "Grammar check: on" : "Grammar check: off"}
                active={grammarEnabled}
                onClick={() => actions.setGrammarEnabled(!grammarEnabled)}
              />
            </ToolbarGroup>
          </>
        )}
      </Toolbar>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onInsertImage(f);
          e.target.value = "";
        }}
      />

      {linkOpen && <LinkEditor editor={editor} onClose={() => setLinkOpen(false)} />}
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
