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

import { createContext, ReactNode, useContext, useEffect, useRef, useState } from "react";
import * as api from "../data/api";

export interface SyncSessionState {
  /** Set when the pull preserved a copy of local work. */
  conflictCopy: string | null;
  /** Why the session couldn't start — usually another device holding it. */
  message: string | null;
  /** Another device took the Satchel over while we were open. */
  lostLease: boolean;
}

const SyncSessionContext = createContext<SyncSessionState>({
  conflictCopy: null,
  message: null,
  lostLease: false,
});

export const useSyncSession = () => useContext(SyncSessionContext);

/** Comfortably inside the backend's 15-minute staleness window, so a brief
 *  network blip doesn't hand the Satchel to another device. */
const HEARTBEAT_MS = 4 * 60 * 1000;

export function SyncSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SyncSessionState>({
    conflictCopy: null,
    message: null,
    lostLease: false,
  });
  const started = useRef(false);

  useEffect(() => {
    // React 18 mounts twice in development; taking the lease twice would be
    // harmless but the pull is not worth doing twice.
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    let timer: number | undefined;

    void (async () => {
      try {
        const report = await api.syncBeginSession();
        if (cancelled || !report) return;
        if (report.conflictCopy) {
          setState((s) => ({ ...s, conflictCopy: report.conflictCopy }));
        }
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, message: String(e) }));
      }

      if (cancelled) return;
      timer = window.setInterval(() => {
        void api
          .syncRefreshLease()
          .then((held) => {
            if (!held) setState((s) => ({ ...s, lostLease: true }));
          })
          .catch(() => {
            // A failed heartbeat is usually a dropped network; staleness is the
            // backstop, so there is nothing useful to say yet.
          });
      }, HEARTBEAT_MS);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);

  return <SyncSessionContext.Provider value={state}>{children}</SyncSessionContext.Provider>;
}
