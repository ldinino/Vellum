import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildExtensions } from "./extensions";
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

function derivePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
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
  const { actions, grammarEnabled, spellcheckEnabled, refineEnabled, refineTemplates, refineAdherence } =
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
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const it of items) {
          if (it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) {
              void insertImage(f);
              return true;
            }
          }
        }
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
    setActiveEditor({ editor, insertImage });
    return () => setActiveEditor(null);
  }, [editor, insertImage, setActiveEditor]);

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
    api
      .loadPageContent(notebookId, page.id)
      .then((json) => {
        if (cancelled) return;
        const doc = json ? JSON.parse(json) : EMPTY_DOC;
        editor.commands.setContent(doc, { emitUpdate: false });
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
    };
  }, [opSaver, snapSaver, grammarSaver]);

  // Load this page's attachments.
  useEffect(() => {
    let active = true;
    api
      .listAttachments(notebookId, page.id)
      .then((a) => active && setAttachments(a))
      .catch((e) => console.error("list attachments failed", e));
    return () => {
      active = false;
    };
  }, [notebookId, page.id]);

  const openAttachment = (id: string) => {
    const a = attachments.find((x) => x.id === id);
    if (a) {
      api.openAttachment(ids.current.notebookId, a.path).catch((e) =>
        console.error("open attachment failed", e),
      );
    }
  };

  const removeAttachment = (id: string) => {
    api
      .removeAttachment(ids.current.notebookId, id)
      .then(() => setAttachments((prev) => prev.filter((x) => x.id !== id)))
      .catch((e) => console.error("remove attachment failed", e));
  };

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed !== page.title) actions.setPageTitle(notebookId, page.id, trimmed);
  };

  return (
    <div
      className="v-editor"
      // Catch-all so a file dropped on a dead zone (padding, title) doesn't make
      // the webview navigate to it; the bar and editor body handle real drops.
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
      <GrammarPopover editor={editor} onAfterAction={() => void runGrammarRef.current()} />
      <EditorContextMenu
        editor={editor}
        onAfterAction={() => void runGrammarRef.current()}
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
