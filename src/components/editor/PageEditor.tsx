import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildExtensions } from "./extensions";
import { isReorderDrag } from "../dnd";
import { setImageSrcResolver } from "./ResizableImage";
import { applySearchHighlight } from "./SearchHighlight";
import { extractText, mapLints } from "./grammar";
import { setGrammarLints, clearGrammarLints } from "./GrammarError";
import { GrammarPopover } from "./GrammarPopover";
import { RefinePreviewModal, RefinePreviewState } from "./RefinePreviewModal";
import { EditorContextMenu } from "./EditorContextMenu";
import type { MenuItem } from "../ui/ContextMenu";
import { insertRefinedText } from "../../lib/refine-markdown";
import { AttachmentBar, AttachmentItem } from "../panels/AttachmentBar";
import { createDebouncer } from "../../lib/debounce";
import { useVellum } from "../../state/vellum";
import { useActiveEditor } from "../../state/activeEditor";
import * as api from "../../data/api";
import type { Attachment, Page, RefineTemplate } from "../../data/types";
import "./editor.css";

/** Release Ollama after this long with no Refine activity (keep-warm idle, spec
 * Section 9 as decided). */
const REFINE_IDLE_RELEASE_MS = 5 * 60 * 1000;

// Fetched once per session: whether this machine is CPU-only (spec Section 9), so
// the Refine preview can warn it may be slow. Module-scoped so it isn't
// re-detected per page.
let cpuOnly = false;
let hardwareChecked = false;

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

// Measure rendered text width (shared canvas) so the title's hover underline can
// hug the title text rather than spanning a fixed length.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function derivePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

// Normalize an image src to a notebook-relative, forward-slash path so it can be
// compared against on-disk attachment paths.
function normalizeSrc(src: string): string {
  return src.replace(/\\/g, "/").replace(/^\/+/, "");
}

// The page's OWN inline-image paths still present in the document (under
// attachments/<pageId>/). These are the files to KEEP; any other immediate file
// in that folder is an orphan the backend cleanup may remove.
function collectPageImageSrcs(editor: Editor, pageId: string): string[] {
  const prefix = `attachments/${pageId}/`;
  const srcs = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") {
      const src = normalizeSrc((node.attrs as { src?: string }).src ?? "");
      if (src.startsWith(prefix)) srcs.add(src);
    }
  });
  return [...srcs];
}

// A pasted plain-text token that is a single http(s) URL → the trimmed URL
// (preserving exactly what was pasted), else null. Lets a pasted bare link get
// a readable label instead of showing the raw address.
function parseSingleUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

// Swap a freshly-pasted link's visible text (still the raw URL) for its fetched
// page title. Matches by href + current text and picks the occurrence nearest
// the paste point, so it stays correct if the same URL was pasted twice or the
// user edited elsewhere while the title loaded. Runs outside undo history and
// leaves the selection untouched (the fetch resolves asynchronously).
function replaceLinkLabel(
  editor: Editor | null,
  href: string,
  oldText: string,
  newText: string,
  nearPos: number,
): void {
  if (!editor || editor.isDestroyed) return;
  const linkType = editor.schema.marks.link;
  if (!linkType) return;
  let foundFrom = -1;
  let foundTo = -1;
  let bestDist = Infinity;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== oldText) return;
    if (!node.marks.some((m) => m.type === linkType && m.attrs.href === href)) return;
    const dist = Math.abs(pos - nearPos);
    if (dist < bestDist) {
      bestDist = dist;
      foundFrom = pos;
      foundTo = pos + node.nodeSize;
    }
  });
  if (foundFrom < 0) return;
  const tr = editor.state.tr
    .insertText(newText, foundFrom, foundTo)
    .addMark(foundFrom, foundFrom + newText.length, linkType.create({ href }))
    .setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function iconForMime(mime: string | null): string {
  if (mime?.startsWith("image/")) return "image";
  if (mime === "text/csv" || mime?.includes("spreadsheet")) return "table";
  return "document";
}

function toAttachmentItem(a: Attachment): AttachmentItem {
  return { id: a.id, filename: a.filename, size: formatBytes(a.size), icon: iconForMime(a.mimeType) };
}

/**
 * One Tiptap editor instance for a single page. Mounted with `key={page.id}`
 * so each page gets a clean editor; unmounting on page switch flushes pending
 * saves. Auto-save writes an op checkpoint (~300ms) and a durable snapshot
 * (~3s); on mount we load the freshest saved content (recovery).
 */
export function PageEditor({
  notebookId,
  page,
  highlightQuery = "",
}: {
  notebookId: string;
  page: Page;
  highlightQuery?: string;
}) {
  const { actions, grammarEnabled, spellcheckEnabled, refineEnabled, refineTemplates, refineAdherence, attachmentsRefreshTick } =
    useVellum();
  const { setActiveEditor } = useActiveEditor();
  const [title, setTitle] = useState(page.title);
  const titleRef = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(true);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Stable per-mount debouncers and identifiers.
  const opSaver = useMemo(() => createDebouncer(300, 1000), []);
  const snapSaver = useMemo(() => createDebouncer(3000, 5000), []);
  // Grammar checks fire ~2s after the user stops typing (spec Section 10).
  const grammarSaver = useMemo(() => createDebouncer(2000, 8000), []);
  const grammarReq = useRef(0);
  // Harper runs if either category is on; mapLints filters per toggle. Refs keep
  // the stable callbacks (runGrammar, onUpdate) reading the latest values.
  const grammarEnabledRef = useRef(grammarEnabled);
  grammarEnabledRef.current = grammarEnabled;
  const spellcheckEnabledRef = useRef(spellcheckEnabled);
  spellcheckEnabledRef.current = spellcheckEnabled;
  const ids = useRef({ notebookId, pageId: page.id });
  ids.current = { notebookId, pageId: page.id };
  const editorRef = useRef<Editor | null>(null);
  // True only once this page's saved content has loaded into the editor. The
  // inline-image cleanup keys on this: an empty doc from a not-yet-loaded or
  // failed load must NOT read as "no images" (that would delete the page's files).
  const loadedOkRef = useRef(false);
  // This page's own inline-image paths still referenced by the doc, refreshed on
  // load + every edit. Read by the cleanup so it never has to touch the editor
  // at unmount (when Tiptap may already be tearing it down).
  const lastImageSrcsRef = useRef<string[]>([]);
  // Foreign image srcs currently being re-homed (copied into this page), so a
  // burst of updates doesn't copy the same file twice.
  const rehomingRef = useRef<Set<string>>(new Set());
  // The .v-editor wrapper — a capture-phase drag listener is attached here to
  // block page-reorder drags before they reach the editable (see effect below).
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // Refine: refs keep the stable callbacks reading the latest library/settings.
  const refineEnabledRef = useRef(refineEnabled);
  refineEnabledRef.current = refineEnabled;
  const refineTemplatesRef = useRef(refineTemplates);
  refineTemplatesRef.current = refineTemplates;
  const refineAdherenceRef = useRef(refineAdherence);
  refineAdherenceRef.current = refineAdherence;
  const refineBusyRef = useRef(false);
  const refineUsedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  // The Refine preview dialog (spec Section 9): status drives the UI; the op ref
  // holds the captured range + result so Keep can insert it; the req token
  // discards a late result if the user cancelled.
  const [refinePreview, setRefinePreview] = useState<RefinePreviewState | null>(null);
  const refineOpRef = useRef<{ from: number; to: number; text: string } | null>(null);
  const refineReqRef = useRef(0);

  // Extract the page text, lint it via Harper, and apply the underlines. Guards
  // against stale results: a superseding request or an edit during the await
  // (positions would have moved) drops the result — a re-check is already queued.
  const runGrammar = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const toggles = {
      grammar: grammarEnabledRef.current,
      spell: spellcheckEnabledRef.current,
    };
    if (!toggles.grammar && !toggles.spell) {
      clearGrammarLints(ed);
      return;
    }
    const reqId = ++grammarReq.current;
    const docAtStart = ed.state.doc;
    const extracted = extractText(docAtStart);
    try {
      const spans = await api.grammarCheck(extracted.text);
      if (grammarReq.current !== reqId || ed.state.doc !== docAtStart) return;
      setGrammarLints(ed, mapLints(spans, extracted, toggles));
    } catch (e) {
      console.error("grammar check failed", e);
    }
  }, []);
  const runGrammarRef = useRef(runGrammar);
  runGrammarRef.current = runGrammar;

  // Release Ollama after a long idle with no in-flight op (keep-warm lifecycle,
  // spec Section 9). Re-arms itself if still busy when it fires. Only armed once
  // Refine has actually been used.
  const scheduleIdleRelease = useCallback(() => {
    if (!refineUsedRef.current) return;
    if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      if (!refineBusyRef.current) {
        api.refineRelease().catch((e) => console.error("refine release failed", e));
        refineUsedRef.current = false;
      } else {
        scheduleIdleRelease();
      }
    }, REFINE_IDLE_RELEASE_MS);
  }, []);

  // Run one Refine op: open the preview dialog with a spinner, transform the
  // captured selection, then show the result for Keep/Cancel (spec Section 9,
  // revised UX). One op at a time per editor; a late result is dropped if the
  // user cancelled (req token).
  const runRefine = useCallback(
    async (ed: Editor, from: number, to: number, template: RefineTemplate) => {
      if (refineBusyRef.current) return;
      const text = ed.state.doc.textBetween(from, to, " ").trim();
      if (!text) return;
      const name = template.name || "Refine";
      const reqId = ++refineReqRef.current;
      refineBusyRef.current = true;
      refineOpRef.current = { from, to, text: "" };
      setRefinePreview({ status: "loading", templateName: name });
      try {
        const adherence = template.adherenceOverride ?? refineAdherenceRef.current;
        const result = await api.refineGenerate({
          text,
          instructions: template.instructions,
          examples: template.examples,
          adherence,
        });
        if (refineReqRef.current !== reqId) return; // cancelled
        const out = result.text.trim();
        if (!out) {
          setRefinePreview({
            status: "error",
            error: "Refine returned an empty result. Try again, or adjust the template.",
            templateName: name,
          });
          return;
        }
        refineOpRef.current = { from, to, text: out };
        setRefinePreview({ status: "done", text: out, templateName: name });
        refineUsedRef.current = true;
        scheduleIdleRelease();
      } catch (e) {
        if (refineReqRef.current !== reqId) return; // cancelled
        setRefinePreview({
          status: "error",
          error: typeof e === "string" ? e : String(e),
          templateName: name,
        });
      } finally {
        refineBusyRef.current = false;
      }
    },
    [scheduleIdleRelease],
  );

  // Keep: insert the approved result, replacing the original selection. The modal
  // backdrop blocks editing while open, so the captured range stays valid.
  const keepRefine = useCallback(() => {
    const ed = editorRef.current;
    const op = refineOpRef.current;
    if (ed && op && op.text) insertRefinedText(ed, op.from, op.to, op.text);
    refineOpRef.current = null;
    setRefinePreview(null);
  }, []);

  const cancelRefine = useCallback(() => {
    refineReqRef.current++; // invalidate any in-flight result
    refineOpRef.current = null;
    refineBusyRef.current = false;
    setRefinePreview(null);
    // Abort the backend generation so Ollama stops chewing CPU immediately.
    api.refineCancel().catch((e) => console.error("refine cancel failed", e));
  }, []);

  // Build the right-click "Refine…" / "Refine ▶" items for the current
  // selection (the EditorContextMenu seam). Absent when Refine is off or there
  // are no templates. Captures the selection range at menu-build time.
  const buildRefineItems = useCallback(
    (selectedText: string): MenuItem[] => {
      const ed = editorRef.current;
      if (!ed || !refineEnabledRef.current) return [];
      const templates = refineTemplatesRef.current;
      if (!templates.length || !selectedText.trim()) return [];
      const { from, to } = ed.state.selection;
      const trigger = (t: RefineTemplate) => () => void runRefine(ed, from, to, t);
      if (templates.length === 1) {
        return [{ label: "Refine…", icon: "wand", onSelect: trigger(templates[0]) }];
      }
      return [
        {
          label: "Refine",
          icon: "wand",
          submenu: templates.map((t) => ({
            label: t.name || "Untitled",
            onSelect: trigger(t),
          })),
        },
      ];
    },
    [runRefine],
  );

  // Store an image (pasted/dropped/inserted) and embed it by relative path.
  // Closes only over refs, so it's stable — safe to register up to the toolbar.
  const insertImage = useCallback(async (file: File) => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const ext = file.name.split(".").pop() || file.type.split("/")[1] || "png";
      const { notebookId, pageId } = ids.current;
      const rel = await api.savePageImage(notebookId, pageId, bytes, ext);
      ed.chain().focus().setImage({ src: rel }).run();
    } catch (e) {
      console.error("image insert failed", e);
    }
  }, []);

  // Copy one or more files into the page's attachments and pin them to the bar.
  // Relies only on ids.current + the stable setter, so it's safe to close over
  // from the editor's drop handler.
  const attachFiles = async (files: FileList | File[]) => {
    const { notebookId, pageId } = ids.current;
    for (const file of Array.from(files)) {
      try {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const att = await api.addAttachment(notebookId, pageId, file.name, bytes, file.type || null);
        setAttachments((prev) => [...prev, att]);
      } catch (e) {
        console.error("attach failed", e);
      }
    }
  };

  // Remove this page's inline-image files that the live document no longer
  // references. Files stay on disk during editing (so undo always works); this
  // runs on navigate-away (fire-and-forget) and on app close (awaited). No-ops
  // until content has loaded, so a blank/not-yet-loaded doc can never wipe the
  // page's images.
  const cleanupImages = useCallback(async () => {
    if (!loadedOkRef.current) return;
    const { notebookId, pageId } = ids.current;
    try {
      await api.cleanupPageImages(notebookId, pageId, lastImageSrcsRef.current);
    } catch (e) {
      console.error("image cleanup failed", e);
    }
  }, []);

  // Persist the latest content synchronously and await it. The app-close path
  // (VellumShell) calls this before destroying the window: the editor isn't
  // unmounted on close, so the pending debounced snapshot would otherwise die
  // with the window. Cancels the debouncers to avoid a duplicate write, and
  // no-ops until content has loaded so a blank pre-load doc can't overwrite it.
  const flushSaves = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !loadedOkRef.current) return;
    opSaver.cancel();
    snapSaver.cancel();
    const { notebookId, pageId } = ids.current;
    try {
      await api.savePageSnapshot(
        notebookId,
        pageId,
        JSON.stringify(ed.getJSON()),
        derivePreview(ed.getText()),
      );
    } catch (e) {
      console.error("flush saves failed", e);
    }
  }, [opSaver, snapSaver]);

  // After a paste carried an image node from another page, copy that file into
  // THIS page's folder and repoint the node, so every page owns its inline
  // images (and per-page cleanup can't delete a file another page still shows).
  const rehomeForeignImages = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const { notebookId, pageId } = ids.current;
    const own = `attachments/${pageId}/`;
    const foreign = new Set<string>();
    ed.state.doc.descendants((node) => {
      if (node.type.name === "image") {
        const src = normalizeSrc((node.attrs as { src?: string }).src ?? "");
        if (src.startsWith("attachments/") && !src.startsWith(own)) foreign.add(src);
      }
    });
    for (const src of foreign) {
      if (rehomingRef.current.has(src)) continue;
      rehomingRef.current.add(src);
      api
        .copyImageToPage(notebookId, src, pageId)
        .then((newRel) => {
          const ed2 = editorRef.current;
          if (!ed2 || ed2.isDestroyed) return;
          let tr = ed2.state.tr;
          let changed = false;
          ed2.state.doc.descendants((node, pos) => {
            if (
              node.type.name === "image" &&
              normalizeSrc((node.attrs as { src?: string }).src ?? "") === src
            ) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newRel });
              changed = true;
            }
          });
          // Repoint outside undo history: undoing the paste removes the node
          // entirely, and the now-unreferenced copy is swept on navigate-away.
          if (changed) ed2.view.dispatch(tr.setMeta("addToHistory", false));
        })
        .catch((e) => console.error("re-home image failed", e))
        .finally(() => rehomingRef.current.delete(src));
    }
  }, []);

  const editor = useEditor({
    extensions: buildExtensions(),
    editorProps: {
      // WebView2 native spell check is off: spelling is sourced from Harper now
      // (spec Section 10 design note), so the native menu's "correct this word"
      // (which JS can't read) is replaced by our themed spelling menu, and we
      // avoid a double red squiggle.
      attributes: { class: "v-prose", spellcheck: "false" },
      handleClick: (_view, _pos, event) => {
        // Ctrl/Cmd-click a link → open in the system browser (plain click
        // keeps editing the text).
        const a = (event.target as HTMLElement)?.closest?.("a");
        const href = a?.getAttribute("href");
        if (href && (event.ctrlKey || event.metaKey)) {
          void openUrl(href);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const cd = event.clipboardData;
        if (!cd) return false;
        // Image on the clipboard → embed it inline.
        for (const it of cd.items) {
          if (it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) {
              void insertImage(f);
              return true;
            }
          }
        }
        // Bare URL pasted into an empty selection: drop the link in now, then
        // swap in the page <title> once fetched so it reads "Google", not the
        // raw address. A non-empty selection is left to the Link extension's
        // linkOnPaste (it wraps the selected text, keeping it as the label);
        // rich (text/html) pastes keep their own markup and anchor text.
        if (!cd.types.includes("text/html")) {
          const url = parseSingleUrl(cd.getData("text/plain"));
          const { from, to } = view.state.selection;
          const ed = editorRef.current;
          if (url && from === to && ed) {
            ed.chain()
              .focus()
              .insertContent({
                type: "text",
                text: url,
                marks: [{ type: "link", attrs: { href: url } }],
              })
              .run();
            void api
              .fetchLinkTitle(url)
              .then((title) => {
                const label = title?.trim();
                if (label && label !== url) {
                  replaceLinkLabel(editorRef.current, url, url, label, from);
                }
              })
              .catch(() => {});
            return true;
          }
        }
        // Rich/HTML paste may carry an image node copied from another page; once
        // the default paste lands, re-home any that aren't ours so this page owns
        // its inline-image files.
        queueMicrotask(rehomeForeignImages);
        return false;
      },
      handleDrop: (_view, event) => {
        // Files dropped into the editor body: images go inline, everything else
        // becomes an attachment (spec Section 12).
        const files = (event as DragEvent).dataTransfer?.files;
        if (!files || files.length === 0) return false;
        event.preventDefault();
        const toAttach: File[] = [];
        for (const f of Array.from(files)) {
          if (f.type.startsWith("image/")) void insertImage(f);
          else toAttach.push(f);
        }
        if (toAttach.length) void attachFiles(toAttach);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (loadingRef.current) return;
      const json = JSON.stringify(editor.getJSON());
      const preview = derivePreview(editor.getText());
      const { notebookId, pageId } = ids.current;
      // Keep the referenced-image set current so navigate-away / close cleanup
      // can run without reading the (possibly tearing-down) editor.
      lastImageSrcsRef.current = collectPageImageSrcs(editor, pageId);
      opSaver.schedule(() => {
        api.appendPageOp(notebookId, pageId, json).catch((e) =>
          console.error("op save failed", e),
        );
      });
      snapSaver.schedule(() => {
        api
          .savePageSnapshot(notebookId, pageId, json, preview)
          .then(() => actions.refreshPages())
          .catch((e) => console.error("snapshot save failed", e));
      });
      if (grammarEnabledRef.current || spellcheckEnabledRef.current) {
        grammarSaver.schedule(() => void runGrammarRef.current());
      }
      // Editing counts as activity: push back the keep-warm idle release.
      if (refineUsedRef.current) scheduleIdleRelease();
    },
  });
  editorRef.current = editor;

  // Publish this page's editor to the shell toolbar; clear it on unmount (page
  // switch / close) so the toolbar disables when no page is open.
  useEffect(() => {
    if (!editor) return;
    setActiveEditor({ editor, insertImage, cleanupImages, flushSaves });
    return () => setActiveEditor(null);
  }, [editor, insertImage, cleanupImages, flushSaves, setActiveEditor]);

  // Point the image NodeView's src resolver at this notebook so relative
  // attachment paths resolve to loadable asset:// URLs.
  useEffect(() => {
    let active = true;
    api
      .notebookPath(notebookId)
      .then((dir) => {
        if (!active) return;
        const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
        setImageSrcResolver((src) =>
          /^(https?:|data:|asset:|blob:|http:\/\/asset)/.test(src)
            ? src
            : convertFileSrc(`${base}/${src.replace(/^\/+/, "")}`),
        );
      })
      .catch((e) => console.error("notebook path failed", e));
    return () => {
      active = false;
    };
  }, [notebookId]);

  // Load saved content (recovery) when the editor is ready.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    loadingRef.current = true;
    loadedOkRef.current = false;
    api
      .loadPageContent(notebookId, page.id)
      .then((json) => {
        if (cancelled) return;
        const doc = json ? JSON.parse(json) : EMPTY_DOC;
        editor.commands.setContent(doc, { emitUpdate: false });
        // Content is now authoritative: the cleanup may trust the doc's images.
        loadedOkRef.current = true;
        lastImageSrcsRef.current = collectPageImageSrcs(editor, page.id);
      })
      .catch((e) => console.error("load page content failed", e))
      .finally(() => {
        if (!cancelled) {
          loadingRef.current = false;
          setContentLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editor, notebookId, page.id]);

  // Highlight search terms (and scroll to the first match) once content is in.
  // Re-runs if the query changes while the same page stays open.
  useEffect(() => {
    if (!editor || !contentLoaded) return;
    const terms = highlightQuery.split(/\s+/).filter(Boolean);
    applySearchHighlight(editor, terms);
  }, [editor, contentLoaded, highlightQuery]);

  // Re-lint on open and whenever either toggle flips; clear underlines when both
  // are off (runGrammar itself clears in that case, so just call it).
  useEffect(() => {
    if (!editor || !contentLoaded) return;
    void runGrammar();
  }, [editor, contentLoaded, grammarEnabled, spellcheckEnabled, runGrammar]);

  // Focus the title of a freshly created (untitled) page.
  useEffect(() => {
    if (page.title === "") requestAnimationFrame(() => titleRef.current?.focus());
  }, [page.id, page.title]);

  // Size the title's hover underline to the title text so it hugs the title —
  // the placeholder when empty (lighter weight), the typed value otherwise.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const text = title || el.placeholder;
    const weight = title ? cs.fontWeight : "400";
    const width = measureTextWidth(text, `${weight} ${cs.fontSize} ${cs.fontFamily}`);
    el.style.setProperty("--title-underline-width", `${Math.ceil(width)}px`);
  }, [title]);

  // Detect CPU-only once per session so Refine can warn at point of use that
  // requests may be slow (spec Section 9). Side-effect free; never starts Ollama.
  useEffect(() => {
    if (hardwareChecked) return;
    hardwareChecked = true;
    api
      .refineDetectHardware()
      .then((hw) => {
        cpuOnly = hw.cpuOnly;
      })
      .catch((e) => console.error("hardware detect failed", e));
  }, []);

  // Flush pending saves on unmount (page switch / app close path); drop any
  // pending grammar check (the editor is going away) and the idle timer.
  useEffect(() => {
    return () => {
      opSaver.flush();
      snapSaver.flush();
      grammarSaver.cancel();
      if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
      // Navigate-away: sweep this page's now-unreferenced inline images
      // (fire-and-forget; no-ops until content has loaded).
      void cleanupImages();
    };
  }, [opSaver, snapSaver, grammarSaver, cleanupImages]);

  // ProseMirror's drop cursor and core drag handling attach their own listeners
  // directly on the editable DOM, so React/editorProps can't suppress them. Catch
  // page-reorder drags in the capture phase on the wrapper — before they descend
  // to the editable — and stop propagation so neither the drop-cursor line nor a
  // droppable cursor appears. preventDefault is intentionally left unset so the
  // editor reads as a no-drop zone for pages; file/text drags are untouched.
  useEffect(() => {
    const el = editorWrapRef.current;
    if (!el) return;
    const block = (e: DragEvent) => {
      if (isReorderDrag(e.dataTransfer)) e.stopPropagation();
    };
    el.addEventListener("dragover", block, true);
    el.addEventListener("dragenter", block, true);
    return () => {
      el.removeEventListener("dragover", block, true);
      el.removeEventListener("dragenter", block, true);
    };
  }, []);

  // Load this page's attachments. Re-runs when an attachment is restored from
  // the Recycle Bin (attachmentsRefreshTick) so the bar reflects it immediately.
  useEffect(() => {
    let active = true;
    api
      .listAttachments(notebookId, page.id)
      .then((a) => active && setAttachments(a))
      .catch((e) => console.error("list attachments failed", e));
    return () => {
      active = false;
    };
  }, [notebookId, page.id, attachmentsRefreshTick]);

  const openAttachment = (id: string) => {
    const a = attachments.find((x) => x.id === id);
    if (a) {
      api.openAttachment(ids.current.notebookId, a.path).catch((e) =>
        console.error("open attachment failed", e),
      );
    }
  };

  const removeAttachment = (id: string) => {
    actions
      .softDeleteAttachment(ids.current.notebookId, id)
      .then(() => setAttachments((prev) => prev.filter((x) => x.id !== id)))
      .catch((e) => console.error("remove attachment failed", e));
  };

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed !== page.title) actions.setPageTitle(notebookId, page.id, trimmed);
  };
  // Also commit a pending title edit on unmount: keyboard/programmatic page
  // switches (and app close) never blur the title input, so onBlur wouldn't fire
  // and the edit would be lost. A latest-ref lets the unmount cleanup commit the
  // current value without re-running on every keystroke.
  const commitTitleRef = useRef(commitTitle);
  commitTitleRef.current = commitTitle;
  useEffect(() => () => commitTitleRef.current(), []);

  return (
    <div
      className="v-editor"
      ref={editorWrapRef}
      // Catch-all so a file dropped on a dead zone (padding, title) doesn't make
      // the webview navigate to it; the bar and editor body handle real drops.
      // Page-reorder drags are stopped earlier (capture listener in an effect),
      // so they never reach here.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      {/* The white "page sheet" floating on the section-tinted desk (OneNote
          2007: paper in a notebook). */}
      <div className="v-editor__page">
        <AttachmentBar
          attachments={attachments.map(toAttachmentItem)}
          onOpen={openAttachment}
          onRemove={removeAttachment}
          onAttachFiles={attachFiles}
        />
        <input
          ref={titleRef}
          className="v-editor__title"
          value={title}
          placeholder="Untitled page"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
              editor?.commands.focus("start");
            }
          }}
        />
        <EditorContent editor={editor} className="v-editor__content" />
      </div>
      <GrammarPopover
        editor={editor}
        onAfterAction={() => void runGrammarRef.current()}
        onAddToDictionary={(word) => actions.addDictionaryWord(word)}
      />
      <EditorContextMenu
        editor={editor}
        onAfterAction={() => void runGrammarRef.current()}
        onAddToDictionary={(word) => actions.addDictionaryWord(word)}
        onIgnoreRule={(kind) => actions.ignoreGrammarRule(kind)}
        buildRefineItems={buildRefineItems}
      />
      <RefinePreviewModal
        state={refinePreview}
        cpuOnly={cpuOnly}
        onKeep={keepRefine}
        onCancel={cancelRefine}
      />
    </div>
  );
}
