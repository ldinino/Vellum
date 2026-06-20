/**
 * Page Templates library + editor (spec Section 7 / Phase 6). Lives under
 * Settings → Templates. Edits are made on a working copy and committed with Save
 * (or thrown away with Discard); the library persists to app.json.
 */

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { buildExtensions } from "../editor/extensions";
import { EditorToolbar } from "../editor/EditorToolbar";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { useVellum } from "../../state/vellum";
import type { PageTemplate } from "../../data/types";
import "./PageTemplatesManager.css";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function now() {
  return new Date().toISOString();
}

function previewOf(t: PageTemplate): string {
  // Best-effort first-line preview from the doc JSON.
  try {
    const text: string[] = [];
    const walk = (n: { text?: string; content?: unknown[] }) => {
      if (n.text) text.push(n.text);
      (n.content as { text?: string; content?: unknown[] }[] | undefined)?.forEach(walk);
    };
    walk(t.contentJson as { content?: unknown[] });
    return text.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return "";
  }
}

export function PageTemplatesManager() {
  const { pageTemplates, actions } = useVellum();
  const [drafts, setDrafts] = useState<PageTemplate[]>(pageTemplates);
  const [selectedId, setSelectedId] = useState<string | null>(pageTemplates[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Adopt the library from context until the user starts editing (handles the
  // async first load); don't clobber unsaved edits.
  useEffect(() => {
    if (!dirty) {
      setDrafts(pageTemplates);
      setSelectedId((cur) => cur ?? pageTemplates[0]?.id ?? null);
    }
  }, [pageTemplates, dirty]);

  const selected = drafts.find((t) => t.id === selectedId) ?? null;

  const editor = useEditor({
    extensions: buildExtensions(),
    editorProps: { attributes: { class: "v-prose" } },
    content: selected?.contentJson ?? EMPTY_DOC,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON();
      const id = selectedIdRef.current;
      setDrafts((ds) =>
        ds.map((t) => (t.id === id ? { ...t, contentJson: json, updatedAt: now() } : t)),
      );
      setDirty(true);
    },
  });

  // Load the selected template into the editor when the selection changes.
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(selected?.contentJson ?? EMPTY_DOC, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, selectedId]);

  const renameSelected = (name: string) => {
    setDrafts((ds) => ds.map((t) => (t.id === selectedId ? { ...t, name, updatedAt: now() } : t)));
    setDirty(true);
  };

  const addTemplate = () => {
    const t: PageTemplate = {
      id: crypto.randomUUID(),
      name: "Untitled template",
      contentJson: EMPTY_DOC,
      createdAt: now(),
      updatedAt: now(),
    };
    setDrafts((ds) => [...ds, t]);
    setSelectedId(t.id);
    setDirty(true);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy: PageTemplate = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} (copy)`,
      createdAt: now(),
      updatedAt: now(),
    };
    setDrafts((ds) => [...ds, copy]);
    setSelectedId(copy.id);
    setDirty(true);
  };

  const deleteSelected = () => {
    if (!selected) return;
    setDrafts((ds) => {
      const next = ds.filter((t) => t.id !== selected.id);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
    setDirty(true);
  };

  const save = () => {
    void actions.savePageTemplates(drafts);
    setDirty(false);
  };

  const discard = () => {
    setDrafts(pageTemplates);
    setSelectedId(pageTemplates[0]?.id ?? null);
    setDirty(false);
  };

  return (
    <div className="v-tmpl">
      <div className="v-tmpl__list">
        <div className="v-tmpl__list-head">
          <span>Templates</span>
          <button type="button" className="v-tmpl__add" title="New template" onClick={addTemplate}>
            <Icon name="plus-small" />
          </button>
        </div>
        <div className="v-tmpl__items">
          {drafts.length === 0 && <div className="v-tmpl__empty">No templates yet.</div>}
          {drafts.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`v-tmpl__item${t.id === selectedId ? " is-selected" : ""}`}
              onClick={() => setSelectedId(t.id)}
            >
              <span className="v-tmpl__item-name">{t.name || "Untitled template"}</span>
              <span className="v-tmpl__item-preview">{previewOf(t)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="v-tmpl__editor">
        {selected ? (
          <>
            <div className="v-tmpl__editor-head">
              <input
                className="v-tmpl__name"
                value={selected.name}
                placeholder="Template name"
                onChange={(e) => renameSelected(e.target.value)}
              />
              <Button icon="document--plus" onClick={duplicateSelected}>
                Duplicate
              </Button>
              <Button icon="cross-small" onClick={deleteSelected}>
                Delete
              </Button>
            </div>
            <EditorToolbar editor={editor} onInsertImage={() => {}} />
            <EditorContent editor={editor} className="v-tmpl__content" />
          </>
        ) : (
          <div className="v-tmpl__placeholder">
            Select a template, or create one, to edit it.
          </div>
        )}
      </div>

      <div className="v-tmpl__footer">
        {dirty && <span className="v-tmpl__dirty">Unsaved changes</span>}
        <Button onClick={discard} disabled={!dirty}>
          Discard
        </Button>
        <Button accent onClick={save} disabled={!dirty}>
          Save
        </Button>
      </div>
    </div>
  );
}
