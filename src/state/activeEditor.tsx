/**
 * Bridges the open page's Tiptap editor up to the shell-level toolbar. The
 * editor lifecycle still lives entirely in PageEditor (keyed by page id); it
 * registers its instance here on mount and clears it on unmount. The unified
 * top toolbar (TopToolbar) reads the active editor from this context, so the
 * formatting controls and the page editor share one instance without prop
 * drilling. `null` means no page is open — the toolbar renders disabled.
 */

import { createContext, ReactNode, useCallback, useContext, useState } from "react";
import type { Editor } from "@tiptap/react";

export interface ActiveEditor {
  editor: Editor;
  /** Store an image file and embed it at the caret (owned by PageEditor). */
  insertImage: (file: File) => void;
}

interface ActiveEditorContextValue {
  active: ActiveEditor | null;
  setActiveEditor: (a: ActiveEditor | null) => void;
}

const ActiveEditorContext = createContext<ActiveEditorContextValue | null>(null);

export function ActiveEditorProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveEditor | null>(null);
  const setActiveEditor = useCallback((a: ActiveEditor | null) => setActive(a), []);
  return (
    <ActiveEditorContext.Provider value={{ active, setActiveEditor }}>
      {children}
    </ActiveEditorContext.Provider>
  );
}

export function useActiveEditor(): ActiveEditorContextValue {
  const ctx = useContext(ActiveEditorContext);
  if (!ctx) throw new Error("useActiveEditor must be used within ActiveEditorProvider");
  return ctx;
}
