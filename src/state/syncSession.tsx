/**
 * Sync session lifecycle.
 *
 * On launch, a synced Satchel takes the single-writer lease and pulls anything
 * newer, then heartbeats while the window is open so another device can tell
 * this one is still here. The lease is handed back by the backend on exit.
 *
 * Everything is deliberately non-blocking and quiet: a missing network, or
 * another device holding the Satchel, must never stop you opening your notes.
 * The result surfaces as a notice, not a modal.
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as api from "../data/api";

export interface SyncSessionState {
  /** Set when the pull preserved a copy of local work. */
  conflictCopy: string | null;
  /** Why the session couldn't start — usually another device holding it. */
  message: string | null;
  /** The device that took the Satchel over while we were open. Set means this
   *  session has stood down: read-only, and the backend refuses to push. */
  takenOverBy: string | null;
  /** Where this session's unsynced work was preserved, once the user asks. */
  preservedCopy: string | null;
  /** Keep unsynced local work as a conflict Satchel beside this one. */
  preserveCopy: () => Promise<void>;
  /** Take the Satchel back. Only ever from an explicit click. */
  takeBack: () => Promise<void>;
  /** Set when preserving or taking back failed. */
  actionError: string | null;
}

const SyncSessionContext = createContext<SyncSessionState>({
  conflictCopy: null,
  message: null,
  takenOverBy: null,
  preservedCopy: null,
  preserveCopy: async () => {},
  takeBack: async () => {},
  actionError: null,
});

export const useSyncSession = () => useContext(SyncSessionContext);

/** Comfortably inside the backend's 15-minute staleness window, so a brief
 *  network blip doesn't hand the Satchel to another device. */
const HEARTBEAT_MS = 4 * 60 * 1000;

export function SyncSessionProvider({ children }: { children: ReactNode }) {
  const [conflictCopy, setConflictCopy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [takenOverBy, setTakenOverBy] = useState<string | null>(null);
  const [preservedCopy, setPreservedCopy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const started = useRef(false);
  // The heartbeat outlives the effect that starts it: taking the Satchel back
  // has to restart it, or this device would hold a lease it never refreshes and
  // silently go stale.
  const timerRef = useRef<number | undefined>(undefined);
  const goneRef = useRef(false);

  const stopHeartbeat = useCallback(() => {
    if (timerRef.current !== undefined) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    if (goneRef.current) return;
    timerRef.current = window.setInterval(() => {
      void api
        .syncRefreshLease()
        .then((standing) => {
          // Only a named holder is a take-over. An absent lease is ordinary:
          // our own "Sync now" hands it back when it finishes.
          if (goneRef.current || !standing.takenOverBy) return;
          setTakenOverBy(standing.takenOverBy);
          // Nothing left to refresh: the Satchel is someone else's until the
          // user asks for it back.
          stopHeartbeat();
        })
        .catch(() => {
          // A failed heartbeat is usually a dropped network. Staleness is the
          // backstop, and a lost connection must never make you read-only.
        });
    }, HEARTBEAT_MS);
  }, [stopHeartbeat]);

  useEffect(() => {
    // Above the guard on purpose: StrictMode's first cleanup sets this true,
    // and the second mount returns early, so resetting it below would leave the
    // session marked gone for good and never start the heartbeat.
    goneRef.current = false;
    // React 18 mounts twice in development; taking the lease twice would be
    // harmless but the pull is not worth doing twice.
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const report = await api.syncBeginSession();
        if (goneRef.current || !report) return;
        if (report.conflictCopy) setConflictCopy(report.conflictCopy);
      } catch (e) {
        if (!goneRef.current) setMessage(String(e));
      }
      startHeartbeat();
    })();

    return () => {
      goneRef.current = true;
      stopHeartbeat();
    };
    // The `started` guard assumes these two are stable, as useCallback([]) makes
    // them: give either a dependency and this effect re-runs, returns early, and
    // the heartbeat stops for the rest of the session.
  }, [startHeartbeat, stopHeartbeat]);

  const preserveCopy = useCallback(async () => {
    setActionError(null);
    try {
      setPreservedCopy(await api.syncPreserveLocalCopy());
    } catch (e) {
      setActionError(String(e));
    }
  }, []);

  const takeBack = useCallback(async () => {
    setActionError(null);
    try {
      await api.syncTakeBack();
      setTakenOverBy(null);
      // We hold the lease again, so it has to be kept alive again.
      startHeartbeat();
    } catch (e) {
      setActionError(String(e));
    }
  }, [startHeartbeat]);

  const value: SyncSessionState = {
    conflictCopy,
    message,
    takenOverBy,
    preservedCopy,
    preserveCopy,
    takeBack,
    actionError,
  };

  return <SyncSessionContext.Provider value={value}>{children}</SyncSessionContext.Provider>;
}
