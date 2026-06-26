/**
 * In-app auto-updater (Phase 11). On launch (release builds only) Vellum
 * silently checks GitHub Releases, downloads any newer version in the
 * background, then surfaces a non-blocking "restart to apply" prompt — work is
 * never interrupted mid-edit. Settings ▸ About drives the same flow on demand.
 *
 * Update artifacts are verified against the minisign public key in
 * tauri.conf.json (that is not code signing). On Windows the app is force-quit
 * the instant the installer runs, bypassing the window-close save flush — so
 * applyUpdate() persists the open page and sweeps its inline images BEFORE
 * installing, mirroring the app-close path in VellumShell.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useActiveEditor } from "./activeEditor";
import * as api from "../data/api";

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; percent: number | null }
  | { kind: "ready"; version: string; notes?: string }
  | { kind: "uptodate" }
  | { kind: "error"; message: string };

interface UpdaterContextValue {
  status: UpdaterStatus;
  /** Check for an update and, if found, download it (Settings ▸ About button). */
  checkNow: () => Promise<void>;
  /** Apply the staged update and relaunch — flushes the open page first. */
  applyUpdate: () => Promise<void>;
}

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

// Only auto-check in a packaged build running under Tauri. In `tauri dev` the
// frontend is served by Vite (import.meta.env.PROD === false) and there is no
// installed app to replace, so the silent startup check is skipped (the manual
// Settings button still works for testing against a real release).
const CAN_AUTO_UPDATE = import.meta.env.PROD && "__TAURI_INTERNALS__" in window;

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const { active } = useActiveEditor();
  // Always-current ref to the open editor so applyUpdate() can flush whatever
  // page is open at install time without re-subscribing.
  const activeRef = useRef(active);
  activeRef.current = active;

  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  // The downloaded-but-not-yet-installed update. Held in a ref so a re-render
  // can never drop the handle between download and install.
  const stagedRef = useRef<Update | null>(null);
  const busyRef = useRef(false);

  const run = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        setStatus({ kind: "uptodate" });
        return;
      }
      stagedRef.current = update;
      setStatus({ kind: "downloading", percent: null });
      let total = 0;
      let received = 0;
      await update.download((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            received += event.data.chunkLength;
            setStatus({
              kind: "downloading",
              percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
            });
            break;
          case "Finished":
            break;
        }
      });
      setStatus({ kind: "ready", version: update.version, notes: update.body || undefined });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message });
      api.logFrontendEvent("error", "updater", `update check failed: ${message}`).catch(() => {});
    } finally {
      busyRef.current = false;
    }
  }, []);

  const applyUpdate = useCallback(async () => {
    const staged = stagedRef.current;
    if (!staged) return;
    // Persist the open page before the installer force-quits the app (Windows).
    // Same refs the window-close path uses, under one timeout cap so a stuck
    // save can never block the update.
    try {
      const a = activeRef.current;
      const work = Promise.all([
        a?.flushSaves?.() ?? Promise.resolve(),
        a?.cleanupImages?.() ?? Promise.resolve(),
      ]);
      await Promise.race([work, new Promise<void>((r) => setTimeout(r, 1500))]);
    } catch {
      /* best effort — never block the update */
    }
    try {
      await staged.install(); // Windows: the process exits here.
      await relaunch(); // macOS/Linux: explicit relaunch (no-op once exiting).
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message });
      api.logFrontendEvent("error", "updater", `update install failed: ${message}`).catch(() => {});
    }
  }, []);

  // One silent check shortly after launch. The delay lets first-run work
  // (welcome seed, search reindex) settle before any background download.
  useEffect(() => {
    if (!CAN_AUTO_UPDATE) return;
    const id = window.setTimeout(() => void run(), 4000);
    return () => window.clearTimeout(id);
  }, [run]);

  const value: UpdaterContextValue = { status, checkNow: run, applyUpdate };
  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}

export function useUpdater(): UpdaterContextValue {
  const ctx = useContext(UpdaterContext);
  if (!ctx) throw new Error("useUpdater must be used within UpdaterProvider");
  return ctx;
}
