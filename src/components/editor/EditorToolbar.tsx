import { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../ui/Toolbar";
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
}

export function EditorToolbar({ editor, onInsertImage }: EditorToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  if (!editor) return <Toolbar>{null}</Toolbar>;

  const run = (fn: () => void) => () => fn();

  return (
    <div className="v-editortoolbar">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton
            icon="edit-bold"
            label="Bold (Ctrl+B)"
            active={editor.isActive("bold")}
            onClick={run(() => editor.chain().focus().toggleBold().run())}
          />
          <ToolbarButton
            icon="edit-italic"
            label="Italic (Ctrl+I)"
            active={editor.isActive("italic")}
            onClick={run(() => editor.chain().focus().toggleItalic().run())}
          />
          <ToolbarButton
            icon="edit-underline"
            label="Underline (Ctrl+U)"
            active={editor.isActive("underline")}
            onClick={run(() => editor.chain().focus().toggleUnderline().run())}
          />
          <ToolbarButton
            icon="edit-strike"
            label="Strikethrough"
            active={editor.isActive("strike")}
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
              active={editor.isActive("heading", { level })}
              onClick={run(() => editor.chain().focus().toggleHeading({ level }).run())}
            />
          ))}
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <select
            className="v-editortoolbar__select"
            title="Font"
            value={editor.getAttributes("textStyle").fontFamily ?? ""}
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
            value={(editor.getAttributes("textStyle").fontSize ?? "").replace("px", "")}
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
            <span style={{ color: editor.getAttributes("textStyle").color ?? "#000" }}>A</span>
            <input
              type="color"
              value={editor.getAttributes("textStyle").color ?? "#000000"}
              onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            />
          </label>
          <label className="v-editortoolbar__color v-editortoolbar__color--hl" title="Highlight">
            <span
              style={{ background: editor.getAttributes("highlight").color ?? "#ffe600" }}
            />
            <input
              type="color"
              value={editor.getAttributes("highlight").color ?? "#ffe600"}
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
            active={editor.isActive({ textAlign: "left" })}
            onClick={run(() => editor.chain().focus().setTextAlign("left").run())}
          />
          <ToolbarButton
            icon="edit-alignment-center"
            label="Align center"
            active={editor.isActive({ textAlign: "center" })}
            onClick={run(() => editor.chain().focus().setTextAlign("center").run())}
          />
          <ToolbarButton
            icon="edit-alignment-right"
            label="Align right"
            active={editor.isActive({ textAlign: "right" })}
            onClick={run(() => editor.chain().focus().setTextAlign("right").run())}
          />
          <ToolbarButton
            icon="edit-alignment-justify"
            label="Justify"
            active={editor.isActive({ textAlign: "justify" })}
            onClick={run(() => editor.chain().focus().setTextAlign("justify").run())}
          />
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            icon="edit-superscript"
            label="Superscript"
            active={editor.isActive("superscript")}
            onClick={run(() => editor.chain().focus().toggleSuperscript().run())}
          />
          <ToolbarButton
            icon="edit-subscript"
            label="Subscript"
            active={editor.isActive("subscript")}
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
            active={editor.isActive("bulletList")}
            onClick={run(() => editor.chain().focus().toggleBulletList().run())}
          />
          <ToolbarButton
            icon="edit-list-order"
            label="Numbered list"
            active={editor.isActive("orderedList")}
            onClick={run(() => editor.chain().focus().toggleOrderedList().run())}
          />
          <ToolbarButton
            icon="edit-quotation"
            label="Blockquote"
            active={editor.isActive("blockquote")}
            onClick={run(() => editor.chain().focus().toggleBlockquote().run())}
          />
          <ToolbarButton
            icon="edit-code"
            label="Code block"
            active={editor.isActive("codeBlock")}
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
          <ToolbarButton icon="table-insert-row" label="Add row below" disabled={!editor.can().addRowAfter()} onClick={run(() => editor.chain().focus().addRowAfter().run())} />
          <ToolbarButton icon="table-delete-row" label="Delete row" disabled={!editor.can().deleteRow()} onClick={run(() => editor.chain().focus().deleteRow().run())} />
          <ToolbarButton icon="table-insert-column" label="Add column after" disabled={!editor.can().addColumnAfter()} onClick={run(() => editor.chain().focus().addColumnAfter().run())} />
          <ToolbarButton icon="table-delete-column" label="Delete column" disabled={!editor.can().deleteColumn()} onClick={run(() => editor.chain().focus().deleteColumn().run())} />
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
            active={editor.isActive("link")}
            onClick={() => setLinkOpen((v) => !v)}
          />
        </ToolbarGroup>
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
