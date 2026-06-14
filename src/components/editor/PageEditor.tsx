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
import { EditorToolbar } from "./EditorToolbar";
import { createDebouncer } from "../../lib/debounce";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import type { Page } from "../../data/types";
import "./editor.css";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function derivePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
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
  const { actions, grammarEnabled } = useVellum();
  const [title, setTitle] = useState(page.title);
  const titleRef = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(true);
  const [contentLoaded, setContentLoaded] = useState(false);

  // Stable per-mount debouncers and identifiers.
  const opSaver = useMemo(() => createDebouncer(300, 1000), []);
  const snapSaver = useMemo(() => createDebouncer(3000, 5000), []);
  // Grammar checks fire ~2s after the user stops typing (spec Section 10).
  const grammarSaver = useMemo(() => createDebouncer(2000, 8000), []);
  const grammarReq = useRef(0);
  const grammarEnabledRef = useRef(grammarEnabled);
  grammarEnabledRef.current = grammarEnabled;
  const ids = useRef({ notebookId, pageId: page.id });
  ids.current = { notebookId, pageId: page.id };
  const editorRef = useRef<Editor | null>(null);

  // Extract the page text, lint it via Harper, and apply the underlines. Guards
  // against stale results: a superseding request or an edit during the await
  // (positions would have moved) drops the result — a re-check is already queued.
  const runGrammar = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!grammarEnabledRef.current) {
      clearGrammarLints(ed);
      return;
    }
    const reqId = ++grammarReq.current;
    const docAtStart = ed.state.doc;
    const extracted = extractText(docAtStart);
    try {
      const spans = await api.grammarCheck(extracted.text);
      if (grammarReq.current !== reqId || ed.state.doc !== docAtStart) return;
      setGrammarLints(ed, mapLints(spans, extracted));
    } catch (e) {
      console.error("grammar check failed", e);
    }
  }, []);
  const runGrammarRef = useRef(runGrammar);
  runGrammarRef.current = runGrammar;

  // Store an image (pasted/dropped/inserted) and embed it by relative path.
  const insertImage = async (file: File) => {
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
  };

  const editor = useEditor({
    extensions: buildExtensions(),
    editorProps: {
      attributes: { class: "v-prose", spellcheck: "true" },
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
        const files = (event as DragEvent).dataTransfer?.files;
        if (files) {
          for (const f of files) {
            if (f.type.startsWith("image/")) {
              event.preventDefault();
              void insertImage(f);
              return true;
            }
          }
        }
        return false;
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
      if (grammarEnabledRef.current) {
        grammarSaver.schedule(() => void runGrammarRef.current());
      }
    },
  });
  editorRef.current = editor;

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

  // Grammar check on open and whenever the toggle flips; clear underlines off.
  useEffect(() => {
    if (!editor || !contentLoaded) return;
    if (grammarEnabled) void runGrammar();
    else clearGrammarLints(editor);
  }, [editor, contentLoaded, grammarEnabled, runGrammar]);

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

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed !== page.title) actions.setPageTitle(notebookId, page.id, trimmed);
  };

  return (
    <div className="v-editor">
      <EditorToolbar editor={editor} onInsertImage={insertImage} />
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
    </div>
  );
}
