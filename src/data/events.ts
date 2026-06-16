// Subscriptions to the backend's Refine progress events (Phase 7). Each returns
// a promise of an unlisten function — call it on cleanup.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ModelProgress, RuntimeProgress } from "./types";

export const onRuntimeProgress = (
  cb: (p: RuntimeProgress) => void,
): Promise<UnlistenFn> =>
  listen<RuntimeProgress>("refine://runtime-progress", (e) => cb(e.payload));

export const onModelProgress = (
  cb: (p: ModelProgress) => void,
): Promise<UnlistenFn> =>
  listen<ModelProgress>("refine://model-progress", (e) => cb(e.payload));

export const onOllamaLog = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<{ line: string }>("refine://ollama-log", (e) => cb(e.payload.line));
