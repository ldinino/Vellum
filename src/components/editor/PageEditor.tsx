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
import { EditorContextMenu } from "./EditorContextMenu";
import { AttachmentBar, AttachmentItem } from "../panels/AttachmentBar";
import { createDebouncer } from "../../lib/debounce";
import { useVellum } from "../../state/vellum";
import { useActiveEditor } from "../../state/activeEditor";
import * as api from "../../data/api";
import type { Attachment, Page } from "../../data/types";
import "./editor.css";

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
  const { actions, grammarEnabled, spellcheckEnabled } = useVellum();
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

  // Flush pending saves on unmount (page switch / app close path); drop any
  // pending grammar check (the editor is going away).
  useEffect(() => {
    return () => {
      opSaver.flush();
      snapSaver.flush();
      grammarSaver.cancel();
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
      <GrammarPopover editor={editor} onAfterAction={() => void runGrammarRef.current()} />
      <EditorContextMenu editor={editor} onAfterAction={() => void runGrammarRef.current()} />
    </div>
  );
}
