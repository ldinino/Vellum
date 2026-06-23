/**
 * Refine template library + editor (spec Section 8). Lives under
 * Settings → Refine → Templates. A Refine template is a named system prompt
 * (plain text, not a Tiptap doc), with an optional description and an optional
 * per-template adherence override. Edits are made on a working copy and
 * committed with Save (or thrown away with Discard); the library persists to
 * app.json.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { AdherenceControl } from "../ui/AdherenceControl";
import { useVellum } from "../../state/vellum";
import type { RefineTemplate } from "../../data/types";
import "./RefineTemplatesManager.css";

/** Guarantee the array/string fields exist so the editor never reads undefined
 * (e.g. a template that predates `examples`, or one returned without it). */
function normalize(templates: RefineTemplate[]): RefineTemplate[] {
  return templates.map((t) => ({
    ...t,
    instructions: t.instructions ?? "",
    examples: t.examples ?? [],
  }));
}

export function RefineTemplatesManager() {
  const { refineTemplates, actions } = useVellum();
  const [drafts, setDrafts] = useState<RefineTemplate[]>(() => normalize(refineTemplates));
  const [selectedId, setSelectedId] = useState<string | null>(refineTemplates[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Adopt the library from context until the user starts editing (handles the
  // async first load); don't clobber unsaved edits.
  useEffect(() => {
    if (!dirtyRef.current) {
      setDrafts(normalize(refineTemplates));
      setSelectedId((cur) => cur ?? refineTemplates[0]?.id ?? null);
    }
  }, [refineTemplates]);

  const selected = drafts.find((t) => t.id === selectedId) ?? null;

  const patch = (id: string, fields: Partial<RefineTemplate>) => {
    setDrafts((ds) => ds.map((t) => (t.id === id ? { ...t, ...fields } : t)));
    setDirty(true);
  };

  const addExample = (id: string) => {
    setDrafts((ds) =>
      ds.map((t) =>
        t.id === id ? { ...t, examples: [...t.examples, { input: "", output: "" }] } : t,
      ),
    );
    setDirty(true);
  };

  const patchExample = (id: string, i: number, fields: Partial<{ input: string; output: string }>) => {
    setDrafts((ds) =>
      ds.map((t) =>
        t.id === id
          ? { ...t, examples: t.examples.map((e, j) => (j === i ? { ...e, ...fields } : e)) }
          : t,
      ),
    );
    setDirty(true);
  };

  const removeExample = (id: string, i: number) => {
    setDrafts((ds) =>
      ds.map((t) => (t.id === id ? { ...t, examples: t.examples.filter((_, j) => j !== i) } : t)),
    );
    setDirty(true);
  };

  const addTemplate = () => {
    const t: RefineTemplate = {
      id: crypto.randomUUID(),
      name: "New template",
      instructions: "",
      examples: [],
      description: null,
      adherenceOverride: null,
    };
    setDrafts((ds) => [...ds, t]);
    setSelectedId(t.id);
    setDirty(true);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy: RefineTemplate = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} (copy)`,
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

  const move = (dir: -1 | 1) => {
    if (!selected) return;
    setDrafts((ds) => {
      const i = ds.findIndex((t) => t.id === selected.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ds.length) return ds;
      const next = [...ds];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  };

  const save = () => {
    void actions.saveRefineTemplates(drafts);
    setDirty(false);
  };

  const discard = () => {
    setDrafts(normalize(refineTemplates));
    setSelectedId(refineTemplates[0]?.id ?? null);
    setDirty(false);
  };

  const selectedIndex = selected ? drafts.findIndex((t) => t.id === selected.id) : -1;

  return (
    <div className="v-rtmpl">
      <div className="v-rtmpl__list">
        <div className="v-rtmpl__list-head">
          <span>Templates</span>
          <button type="button" className="v-rtmpl__add" title="New template" onClick={addTemplate}>
            <Icon name="plus-small" />
          </button>
        </div>
        <div className="v-rtmpl__items">
          {drafts.length === 0 && <div className="v-rtmpl__empty">No Refine templates yet.</div>}
          {drafts.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`v-rtmpl__item${t.id === selectedId ? " is-selected" : ""}`}
              onClick={() => setSelectedId(t.id)}
            >
              <span className="v-rtmpl__item-name">{t.name || "Untitled"}</span>
              <span className="v-rtmpl__item-sub">
                {t.description?.trim() || t.instructions.replace(/\s+/g, " ").trim().slice(0, 60)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="v-rtmpl__editor">
        {selected ? (
          <>
            <div className="v-rtmpl__editor-head">
              <input
                className="v-rtmpl__name"
                value={selected.name}
                placeholder="Template name"
                onChange={(e) => patch(selected.id, { name: e.target.value })}
              />
              <button
                type="button"
                className="v-rtmpl__iconbtn"
                title="Move up"
                disabled={selectedIndex <= 0}
                onClick={() => move(-1)}
              >
                <Icon name="arrow-090" />
              </button>
              <button
                type="button"
                className="v-rtmpl__iconbtn"
                title="Move down"
                disabled={selectedIndex < 0 || selectedIndex >= drafts.length - 1}
                onClick={() => move(1)}
              >
                <Icon name="arrow-270" />
              </button>
              <Button icon="document--plus" onClick={duplicateSelected}>
                Duplicate
              </Button>
              <Button icon="cross-small" onClick={deleteSelected}>
                Delete
              </Button>
            </div>

            <div className="v-rtmpl__form">
              <label className="v-rtmpl__field">
                <span className="v-rtmpl__label">Description (optional)</span>
                <input
                  className="v-rtmpl__text"
                  value={selected.description ?? ""}
                  placeholder="Shown in the Refine menu"
                  onChange={(e) =>
                    patch(selected.id, { description: e.target.value || null })
                  }
                />
              </label>

              <label className="v-rtmpl__field v-rtmpl__field--grow">
                <span className="v-rtmpl__label">Instructions</span>
                <textarea
                  className="v-rtmpl__prompt"
                  value={selected.instructions}
                  placeholder="Describe how Refine should transform the selected text…"
                  onChange={(e) => patch(selected.id, { instructions: e.target.value })}
                />
              </label>

              <div className="v-rtmpl__field">
                <div className="v-rtmpl__examples-head">
                  <span className="v-rtmpl__label">Examples (optional)</span>
                  <button
                    type="button"
                    className="v-rtmpl__add"
                    title="Add example"
                    onClick={() => addExample(selected.id)}
                  >
                    <Icon name="plus-small" />
                  </button>
                </div>
                <p className="v-rtmpl__hint">
                  A few before/after pairs make Refine far more reliable, especially for
                  strict formats.
                </p>
                {selected.examples.map((ex, i) => (
                  <div key={i} className="v-rtmpl__example">
                    <div className="v-rtmpl__example-head">
                      <span className="v-rtmpl__example-num">Example {i + 1}</span>
                      <button
                        type="button"
                        className="v-rtmpl__iconbtn"
                        title="Remove example"
                        onClick={() => removeExample(selected.id, i)}
                      >
                        <Icon name="cross-small" />
                      </button>
                    </div>
                    <textarea
                      className="v-rtmpl__example-text"
                      value={ex.input}
                      placeholder="Input…"
                      onChange={(e) => patchExample(selected.id, i, { input: e.target.value })}
                    />
                    <textarea
                      className="v-rtmpl__example-text"
                      value={ex.output}
                      placeholder="Output…"
                      onChange={(e) => patchExample(selected.id, i, { output: e.target.value })}
                    />
                  </div>
                ))}
              </div>

              <div className="v-rtmpl__field">
                <label className="v-rtmpl__check">
                  <input
                    type="checkbox"
                    checked={selected.adherenceOverride != null}
                    onChange={(e) =>
                      patch(selected.id, {
                        adherenceOverride: e.target.checked ? 0.5 : null,
                      })
                    }
                  />
                  <span>Override the global Strict ↔ Liberal setting</span>
                </label>
                {selected.adherenceOverride != null && (
                  <AdherenceControl
                    value={selected.adherenceOverride}
                    onChange={(v) => patch(selected.id, { adherenceOverride: v })}
                  />
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="v-rtmpl__placeholder">
            Select a template, or create one, to edit it.
          </div>
        )}
      </div>

      <div className="v-rtmpl__footer">
        {dirty && <span className="v-rtmpl__dirty">Unsaved changes</span>}
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
