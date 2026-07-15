/**
 * Import documents into a notebook (execution-plan #4) — the mirror of the
 * Export-to-Markdown wizard. Pick one or more files (Markdown / HTML / text /
 * Word) or a whole folder, choose where they land, and each document becomes a
 * page. A folder is imported round-trip: its top-level subfolders become
 * sections (files at the root go into the chosen section), which also makes
 * Vellum an importer for an exported Azure DevOps wiki.
 *
 * Split like the export wizard: the frontend converts each document to editor
 * JSON (lib/import-document.ts) and drives the normal create/save commands; the
 * backend owns the filesystem reads (import_read_file / import_scan_folder /
 * import_copy_external_image). Import only ever *creates* pages, so there's no
 * data-loss risk and no confirmation step — just a progress + summary.
 */

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { useVellum } from "../state/vellum";
import * as api from "../data/api";
import {
  convertDocument,
  decodeDataUri,
  describeBytes,
  docPreview,
  formatForExt,
  IMPORT_EXTENSIONS,
  rehomeImages,
} from "../lib/import-document";
import type { ImportEntry, Section } from "../data/types";
import "./ImportWizard.css";

type Phase = "configure" | "running" | "done" | "error";

/** One document to import, with the paths its images resolve against. */
interface PlanFile {
  absPath: string;
  /** The document's own folder (relative image refs resolve here). */
  baseDir: string;
  /** The import root (`/…` image refs resolve here; == baseDir for a single file). */
  rootDir: string;
  ext: string;
  /** Page title used when the document has no leading H1 (the filename stem). */
  titleFallback: string;
}

/** A target section for a group of documents. */
interface PlanSection {
  /** null → import into the chosen destination section; else create a new
   * section with this name (a folder import's subfolder). */
  newName: string | null;
  files: PlanFile[];
}

// --- Path helpers (handle both / and \) ------------------------------------

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Individually-picked files → one group into the chosen destination section. */
function buildFilesPlan(paths: string[]): PlanSection[] {
  const files: PlanFile[] = paths.map((p) => ({
    absPath: p,
    baseDir: dirname(p),
    rootDir: dirname(p),
    ext: extOf(basename(p)),
    titleFallback: stem(basename(p)),
  }));
  return [{ newName: null, files }];
}

/** A scanned folder → root files into the chosen section, each top-level
 * subfolder into a new section of the same name. */
function buildFolderPlan(root: string, entries: ImportEntry[]): PlanSection[] {
  const groups = new Map<string | null, PlanFile[]>();
  for (const e of entries) {
    const slash = e.relPath.indexOf("/");
    const key = slash < 0 ? null : e.relPath.slice(0, slash);
    const file: PlanFile = {
      absPath: e.absPath,
      baseDir: dirname(e.absPath),
      rootDir: root,
      ext: e.ext,
      titleFallback: stem(basename(e.relPath)),
    };
    const arr = groups.get(key);
    if (arr) arr.push(file);
    else groups.set(key, [file]);
  }
  const sections: PlanSection[] = [];
  const rootFiles = groups.get(null);
  if (rootFiles) sections.push({ newName: null, files: rootFiles });
  [...groups.keys()]
    .filter((k): k is string => k !== null)
    .sort((a, b) => a.localeCompare(b))
    .forEach((k) => sections.push({ newName: k, files: groups.get(k) ?? [] }));
  return sections;
}

export function ImportWizard({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const { notebooks, selectedNotebookId, selectedSectionId, actions } = useVellum();

  const [phase, setPhase] = useState<Phase>("configure");
  const [source, setSource] = useState<{ kind: "files" | "folder"; label: string } | null>(null);
  const [plan, setPlan] = useState<PlanSection[]>([]);
  const [destNotebookId, setDestNotebookId] = useState<string>("");
  const [sections, setSections] = useState<Section[]>([]);
  const [destSectionId, setDestSectionId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ pages: number; sections: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset each time the wizard opens; default the destination to the current
  // selection.
  useEffect(() => {
    if (!isOpen) return;
    setPhase("configure");
    setSource(null);
    setPlan([]);
    setScanning(false);
    setProgress(null);
    setResult(null);
    setErrorMsg(null);
    setDestNotebookId(selectedNotebookId ?? notebooks[0]?.id ?? "");
    // selectedNotebookId/notebooks read once on open (intentional snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load the chosen notebook's sections (for the destination picker + preview).
  useEffect(() => {
    if (!isOpen || !destNotebookId) {
      setSections([]);
      return;
    }
    let alive = true;
    api
      .listSections(destNotebookId)
      .then((secs) => {
        if (!alive) return;
        setSections(secs);
        setDestSectionId((prev) => {
          if (prev && secs.some((s) => s.id === prev)) return prev;
          if (selectedSectionId && secs.some((s) => s.id === selectedSectionId)) {
            return selectedSectionId;
          }
          return secs[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (alive) setSections([]);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, destNotebookId, selectedSectionId]);

  const totalFiles = plan.reduce((n, g) => n + g.files.length, 0);
  const newSectionCount = plan.filter((g) => g.newName !== null).length;
  const needsDestSection = plan.some((g) => g.newName === null && g.files.length > 0);
  const destSectionName =
    sections.find((s) => s.id === destSectionId)?.name ?? "Imported (new section)";

  const chooseFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Documents", extensions: IMPORT_EXTENSIONS }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    setErrorMsg(null);
    setSource({ kind: "files", label: paths.length === 1 ? basename(paths[0]) : `${paths.length} files` });
    setPlan(buildFilesPlan(paths));
  };

  const chooseFolder = async () => {
    const picked = await open({ directory: true, title: "Choose a folder to import" });
    if (!picked || Array.isArray(picked)) return;
    setScanning(true);
    setErrorMsg(null);
    try {
      const entries = await api.importScanFolder(picked);
      setSource({ kind: "folder", label: picked });
      setPlan(entries.length === 0 ? [] : buildFolderPlan(picked, entries));
    } catch (e) {
      setErrorMsg(typeof e === "string" ? e : String(e));
      setPhase("error");
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!destNotebookId || totalFiles === 0) return;
    setPhase("running");
    setProgress({ done: 0, total: totalFiles });
    try {
      let done = 0;
      let createdSections = 0;
      let firstNav: { sectionId: string; pageId: string } | null = null;

      for (const group of plan) {
        // Resolve (or create) the section this group's pages go into.
        let sectionId: string;
        if (group.newName === null) {
          sectionId =
            destSectionId ??
            (sections[0]?.id ?? (await api.createSection(destNotebookId, "Imported")).id);
          if (!destSectionId && !sections[0]) createdSections += 1;
        } else {
          sectionId = (await api.createSection(destNotebookId, group.newName)).id;
          createdSections += 1;
        }

        for (const file of group.files) {
          const format = formatForExt(file.ext);
          if (!format) {
            done += 1;
            setProgress({ done, total: totalFiles });
            continue;
          }
          const bytes = await api.importReadFile(file.absPath);
          const { title, doc } = await convertDocument(format, bytes).catch((err) => {
            void api.logFrontendEvent(
              "error",
              "import",
              `convert "${file.absPath}" (${format}) failed: ${String(err)} — ${describeBytes(bytes)}`,
            );
            throw err;
          });
          const page = await api.createPage(
            destNotebookId,
            sectionId,
            (title ?? file.titleFallback ?? "Untitled") || "Untitled",
          );
          // Re-home referenced images: embedded data URIs become page files;
          // on-disk paths are copied from the source; external URLs stay put.
          const withImages = await rehomeImages(doc, async (src) => {
            const dataUri = decodeDataUri(src);
            if (dataUri) return api.savePageImage(destNotebookId, page.id, dataUri.bytes, dataUri.ext);
            // The backend skips URLs / data URIs / anything outside the root.
            return api.importCopyExternalImage(
              destNotebookId,
              page.id,
              file.baseDir,
              file.rootDir,
              src,
            );
          });
          await api.savePageSnapshot(
            destNotebookId,
            page.id,
            JSON.stringify(withImages),
            docPreview(withImages),
          );
          if (!firstNav) firstNav = { sectionId, pageId: page.id };
          done += 1;
          setProgress({ done, total: totalFiles });
        }
      }

      await actions.reload();
      if (firstNav) {
        await actions.openPage(destNotebookId, firstNav.sectionId, firstNav.pageId);
      }
      setResult({ pages: done, sections: createdSections });
      setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setErrorMsg(msg);
      setPhase("error");
    }
  };

  const footer =
    phase === "configure" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button accent onClick={() => void runImport()} disabled={totalFiles === 0 || !destNotebookId}>
          {totalFiles === 1 ? "Import 1 page" : `Import ${totalFiles || ""} pages`.trim()}
        </Button>
      </>
    ) : phase === "done" || phase === "error" ? (
      <Button accent onClick={onClose}>
        Close
      </Button>
    ) : null;

  return (
    <Modal
      title="Import documents"
      open={isOpen}
      onClose={phase === "running" ? () => {} : onClose}
      width={520}
      footer={footer}
    >
      {phase === "configure" && (
        <div className="v-imp">
          <div className="v-imp__pick">
            <Button icon="documents-stack" onClick={() => void chooseFiles()}>
              Choose files…
            </Button>
            <Button icon="folder" onClick={() => void chooseFolder()}>
              Choose folder…
            </Button>
          </div>

          <p className="v-imp__hint">
            {scanning
              ? "Scanning folder…"
              : source
                ? source.kind === "folder"
                  ? `Folder: ${source.label}`
                  : `Selected: ${source.label}`
                : "Import Markdown, HTML, text, or Word (.docx) files, or a whole folder (subfolders become sections)."}
          </p>

          {totalFiles > 0 && (
            <>
              <div className="v-imp__dest">
                <label className="v-imp__field">
                  <span>Notebook</span>
                  <select
                    value={destNotebookId}
                    onChange={(e) => setDestNotebookId(e.target.value)}
                  >
                    {notebooks.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </label>
                {needsDestSection && (
                  <label className="v-imp__field">
                    <span>Section</span>
                    <select
                      value={destSectionId ?? ""}
                      onChange={(e) => setDestSectionId(e.target.value || null)}
                    >
                      {sections.length === 0 && <option value="">Imported (new section)</option>}
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="v-imp__tree">
                {plan.map((g, gi) => (
                  <div key={gi} className="v-imp__group">
                    <div className="v-imp__section">
                      {g.newName === null ? (
                        <span>{destSectionName}</span>
                      ) : (
                        <>
                          <span>{g.newName}</span>
                          <span className="v-imp__badge">new section</span>
                        </>
                      )}
                    </div>
                    {g.files.map((f, fi) => (
                      <div key={fi} className="v-imp__page">
                        {f.titleFallback || "Untitled"}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <p className="v-imp__summary">
                {totalFiles === 1
                  ? "1 page"
                  : `${totalFiles} pages`}
                {newSectionCount > 0 &&
                  ` in ${newSectionCount} new ${newSectionCount === 1 ? "section" : "sections"}`}
                .
              </p>
            </>
          )}

          {source && totalFiles === 0 && !scanning && (
            <p className="v-imp__hint">No importable documents found here.</p>
          )}
        </div>
      )}

      {phase === "running" && (
        <div className="v-imp v-imp__status">
          <p>
            {progress
              ? `Importing ${progress.done} of ${progress.total} pages…`
              : "Importing…"}
          </p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="v-imp v-imp__status">
          <p className="v-imp__ok">
            <Icon name="tick" /> Imported {result.pages} {result.pages === 1 ? "page" : "pages"}
            {result.sections > 0 &&
              ` into ${result.sections} new ${result.sections === 1 ? "section" : "sections"}`}
            .
          </p>
        </div>
      )}

      {phase === "error" && (
        <div className="v-imp v-imp__status">
          <p className="v-imp__err">
            <Icon name="exclamation" /> {errorMsg ?? "Import failed."}
          </p>
        </div>
      )}
    </Modal>
  );
}
