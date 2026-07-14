/**
 * Export to Markdown wizard (execution-plan #6).
 *
 * Replaces the single "Export Page as Markdown…" action with a small modal that
 * picks a scope (current page / chosen pages / whole section / whole notebook),
 * then exports. One page goes to a chosen `.md` file with a sibling
 * `.attachments/` folder (unchanged from before); several pages lay out as
 * `<Notebook>/<Section>/<Page>.md` under a chosen folder with one shared
 * `.attachments/` at its root. Pages that aren't open are read straight from the
 * store and converted headlessly (see lib/export-markdown.ts), so no editor has
 * to be mounted.
 */

import { useEffect, useMemo, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { useVellum } from "../state/vellum";
import { useActiveEditor } from "../state/activeEditor";
import * as api from "../data/api";
import { exportSinglePageToFile, exportPagesToFolder } from "../lib/export-markdown";
import type { Page, Section } from "../data/types";
import "./ExportWizard.css";

type Scope = "current" | "choose" | "section" | "notebook";
type Phase = "configure" | "running" | "done" | "error";

interface SectionPages {
  section: Section;
  pages: Page[];
}

/** Directory portion of a file path (Windows or POSIX separators). */
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

export function ExportWizard({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const { notebooks, selectedNotebookId, selectedSectionId, selectedPageId } = useVellum();
  const { active } = useActiveEditor();

  const notebook = notebooks.find((n) => n.id === selectedNotebookId) ?? null;
  const notebookName = notebook?.name ?? "Notebook";

  const [scope, setScope] = useState<Scope>("current");
  const [tree, setTree] = useState<SectionPages[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [includeToc, setIncludeToc] = useState(false);
  const [phase, setPhase] = useState<Phase>("configure");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ count: number; path: string; single: boolean } | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset and load the notebook's section/page tree each time the wizard opens.
  useEffect(() => {
    if (!isOpen || !selectedNotebookId) return;
    let alive = true;
    setPhase("configure");
    setScope(selectedPageId ? "current" : "section");
    setChecked(new Set());
    setIncludeToc(false);
    setResult(null);
    setErrorMsg(null);
    setProgress(null);
    setTree(null);
    (async () => {
      try {
        const sections = await api.listSections(selectedNotebookId);
        const withPages = await Promise.all(
          sections.map(async (section) => ({
            section,
            pages: await api.listPages(selectedNotebookId, section.id),
          })),
        );
        if (alive) setTree(withPages);
      } catch (e) {
        if (alive) {
          setErrorMsg(typeof e === "string" ? e : String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, selectedNotebookId, selectedPageId]);

  // The pages (with their section) that the current scope resolves to.
  const resolvedPages = useMemo(() => {
    if (!tree) return [];
    const all = tree.flatMap((sp) => sp.pages.map((page) => ({ page, section: sp.section })));
    switch (scope) {
      case "current":
        return all.filter((x) => x.page.id === selectedPageId);
      case "section":
        return all.filter((x) => x.section.id === selectedSectionId);
      case "notebook":
        return all;
      case "choose":
        return all.filter((x) => checked.has(x.page.id));
      default:
        return [];
    }
  }, [tree, scope, selectedPageId, selectedSectionId, checked]);

  const count = resolvedPages.length;

  const togglePage = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSection = (sp: SectionPages) =>
    setChecked((prev) => {
      const next = new Set(prev);
      const allOn = sp.pages.length > 0 && sp.pages.every((p) => next.has(p.id));
      for (const p of sp.pages) {
        if (allOn) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  const runExport = async () => {
    if (!selectedNotebookId || count === 0) return;
    // Persist the open page's pending (debounced) edits so its export is current.
    // `flushSaves()` is absent when no editor is mounted, hence Promise.resolve.
    await Promise.resolve(active?.flushSaves()).catch(() => {});
    try {
      if (count === 1) {
        const only = resolvedPages[0];
        const mdPath = await save({
          defaultPath: `${only.page.title || "Untitled"}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (!mdPath) return; // cancelled — stay on configure
        setPhase("running");
        await exportSinglePageToFile({
          notebookId: selectedNotebookId,
          pageId: only.page.id,
          title: only.page.title,
          mdPath,
        });
        setResult({ count: 1, path: mdPath, single: true });
      } else {
        const dir = await open({ directory: true, title: "Choose a folder to export into" });
        if (!dir || Array.isArray(dir)) return; // cancelled
        setPhase("running");
        setProgress({ done: 0, total: count });
        const n = await exportPagesToFolder({
          notebookId: selectedNotebookId,
          notebookName,
          destDir: dir,
          pages: resolvedPages.map((x) => ({
            pageId: x.page.id,
            title: x.page.title,
            sectionName: x.section.name,
          })),
          includeToc,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        setResult({ count: n, path: dir, single: false });
      }
      setPhase("done");
    } catch (e) {
      setErrorMsg(typeof e === "string" ? e : `Export failed: ${String(e)}`);
      setPhase("error");
    }
  };

  const revealResult = () => {
    if (!result) return;
    const target = result.single ? parentDir(result.path) : result.path;
    void api.revealPath(target);
  };

  const scopeOption = (value: Scope, label: string, disabled = false) => (
    <label className={`v-exp__radio${disabled ? " v-exp__radio--disabled" : ""}`}>
      <input
        type="radio"
        name="v-exp-scope"
        checked={scope === value}
        disabled={disabled}
        onChange={() => setScope(value)}
      />
      <span>{label}</span>
    </label>
  );

  const footer =
    phase === "configure" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button accent onClick={() => void runExport()} disabled={count === 0}>
          {count === 1 ? "Export…" : `Export ${count || ""} pages…`.trim()}
        </Button>
      </>
    ) : phase === "done" ? (
      <>
        <Button icon="blue-folder" onClick={revealResult}>
          Open folder
        </Button>
        <Button accent onClick={onClose}>
          Close
        </Button>
      </>
    ) : phase === "error" ? (
      <Button accent onClick={onClose}>
        Close
      </Button>
    ) : null;

  return (
    <Modal
      title="Export to Markdown"
      open={isOpen}
      onClose={phase === "running" ? () => {} : onClose}
      width={520}
      footer={footer}
    >
      {phase === "configure" && (
        <div className="v-exp">
          <fieldset className="v-exp__scope">
            <legend>What to export</legend>
            {scopeOption("current", "Current page", !selectedPageId)}
            {scopeOption("choose", "Choose pages…")}
            {scopeOption("section", "Entire section", !selectedSectionId)}
            {scopeOption("notebook", "Entire notebook")}
          </fieldset>

          {scope === "choose" && (
            <div className="v-exp__tree">
              {!tree ? (
                <p className="v-exp__hint">Loading pages…</p>
              ) : tree.length === 0 ? (
                <p className="v-exp__hint">This notebook has no pages.</p>
              ) : (
                tree.map((sp) => {
                  const allOn = sp.pages.length > 0 && sp.pages.every((p) => checked.has(p.id));
                  const someOn = sp.pages.some((p) => checked.has(p.id));
                  return (
                    <div key={sp.section.id} className="v-exp__group">
                      <label className="v-exp__check v-exp__check--section">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = someOn && !allOn;
                          }}
                          disabled={sp.pages.length === 0}
                          onChange={() => toggleSection(sp)}
                        />
                        <span>{sp.section.name}</span>
                      </label>
                      {sp.pages.map((p) => (
                        <label key={p.id} className="v-exp__check v-exp__check--page">
                          <input
                            type="checkbox"
                            checked={checked.has(p.id)}
                            onChange={() => togglePage(p.id)}
                          />
                          <span>{p.title || "Untitled"}</span>
                        </label>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {count > 1 && (
            <label className="v-exp__check v-exp__toc">
              <input
                type="checkbox"
                checked={includeToc}
                onChange={(e) => setIncludeToc(e.target.checked)}
              />
              <span>
                Add a table of contents to each page <code>[[_TOC_]]</code>
              </span>
            </label>
          )}

          <p className="v-exp__summary">
            {count === 0
              ? "Nothing selected yet."
              : count === 1
                ? "1 page — you'll choose a file to save."
                : `${count} pages — you'll choose a folder to export into.`}
          </p>
        </div>
      )}

      {phase === "running" && (
        <div className="v-exp v-exp__status">
          <p>
            {progress
              ? `Exporting ${progress.done} of ${progress.total} pages…`
              : "Exporting…"}
          </p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="v-exp v-exp__status">
          <p className="v-exp__ok">
            <Icon name="tick" /> Exported {result.count} {result.count === 1 ? "page" : "pages"}.
          </p>
          <code className="v-exp__path">{result.path}</code>
        </div>
      )}

      {phase === "error" && (
        <div className="v-exp v-exp__status">
          <p className="v-exp__err">
            <Icon name="exclamation" /> {errorMsg ?? "Export failed."}
          </p>
        </div>
      )}
    </Modal>
  );
}
