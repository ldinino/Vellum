/**
 * Sync session lifecycle.
 *
 * On launch, a synced Satchel takes the single-writer lease and pulls anything
 * newer, then heartbeats while the window is open so another device can tell
 * this one is still here. The lease is handed back by the backend on exit.
 *
 * It is also handed back on the way *out of the room* (docs 5.2): once the
 * window is unfocused and has been still for a while — or the workstation locks
 * or the machine sleeps — this device syncs and lets go, so the next one finds
 * the Satchel free. Coming back takes it again in the background while the
 * window carries on accepting edits.
 *
 * Everything is deliberately non-blocking and quiet: a missing network, or
 * another device holding the Satchel, must never stop you opening your notes.
 * The result surfaces as a notice, not a modal.
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "../data/api";
import { onDeviceGone } from "../data/events";
import { msUntilYield } from "../lib/yield-lease";

export interface SyncSessionState {
  /** Set when the pull preserved a copy of local work. */
  conflictCopy: string | null;
  /** Why the session couldn't start — usually another device holding it. */
  message: string | null;
  /** The device that took the Satchel over while we were open. Set means this
   *  session has stood down: read-only, and the backend refuses to push. */
  takenOverBy: string | null;
  /** True while this device has handed the Satchel back for its other devices
   *  to use. Unlike a take-over this is not a restriction: editing continues,
   *  and returning to the window takes the Satchel back by itself. */
  yielded: boolean;
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
  yielded: false,
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
  const [yielded, setYielded] = useState(false);
  const [preservedCopy, setPreservedCopy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const started = useRef(false);
  // The heartbeat outlives the effect that starts it: taking the Satchel back
  // has to restart it, or this device would hold a lease it never refreshes and
  // silently go stale.
  const timerRef = useRef<number | undefined>(undefined);
  const goneRef = useRef(false);
  // Mirrors of the state the yield path reads from callbacks and timers, which
  // never see a re-render.
  const yieldedRef = useRef(false);
  const takenOverRef = useRef<string | null>(null);
  takenOverRef.current = takenOverBy;
  // One handover at a time: yielding is a full sync, and overlapping it with a
  // re-acquire would race for the same lease file.
  const busyRef = useRef(false);

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
      takenOverRef.current = null;
      // We hold the lease again, so it has to be kept alive again.
      startHeartbeat();
    } catch (e) {
      setActionError(String(e));
    }
  }, [startHeartbeat]);

  // Hand the Satchel back: a final sync, then let go, so the next device finds
  // it free. Silent by design — this runs when nobody is at the machine, and a
  // failure is not worth a notice they will never read. Staleness is still the
  // backstop, exactly as it was before.
  const handOver = useCallback(async () => {
    if (goneRef.current || yieldedRef.current || busyRef.current) return;
    // Standing down already means it isn't ours to hand over.
    if (takenOverRef.current) return;
    busyRef.current = true;
    try {
      await api.syncYieldLease();
      if (goneRef.current) return;
      yieldedRef.current = true;
      setYielded(true);
      // Nothing of ours left on the remote to refresh.
      stopHeartbeat();
    } catch {
      /* best effort */
    } finally {
      busyRef.current = false;
    }
  }, [stopHeartbeat]);

  // Coming back. Optimistic on purpose: the window never stopped accepting
  // edits, so the notice goes first and the round trip happens behind it. Only
  // finding somebody else there interrupts, and that lands in the take-over
  // path this file already has rather than a second one.
  const resume = useCallback(async () => {
    if (goneRef.current || !yieldedRef.current || busyRef.current) return;
    yieldedRef.current = false;
    setYielded(false);
    busyRef.current = true;
    try {
      const standing = await api.syncResumeSession();
      if (goneRef.current) return;
      if (standing.takenOverBy) {
        setTakenOverBy(standing.takenOverBy);
        takenOverRef.current = standing.takenOverBy;
        return;
      }
      startHeartbeat();
    } catch {
      // Couldn't reach the storage. We are no worse off than any other offline
      // moment, so carry on and let the heartbeat keep trying.
      if (!goneRef.current) startHeartbeat();
    } finally {
      busyRef.current = false;
    }
  }, [startHeartbeat]);

  // Presence: unfocused *and* idle hands the Satchel back; a lock or a suspend
  // does it at once. Re-runs safely, so it carries no once-only guard.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // Per-run locals, not refs: StrictMode's mount → cleanup → mount would leave
    // a ref holding the first run's timer, which the second run would never
    // clear.
    let disposed = false;
    let focused = true;
    let lastInputAt = Date.now();
    let timer: number | undefined;
    let unlistenFocus: (() => void) | undefined;
    let unlistenGone: (() => void) | undefined;

    const arm = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (disposed) return;
      const wait = msUntilYield({ focused, lastInputAt }, Date.now());
      if (wait === null) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        // Re-read rather than trust the timer: focus can have come back, or
        // input arrived, since it was armed.
        if (msUntilYield({ focused, lastInputAt }, Date.now()) === 0) void handOver();
        else arm();
      }, wait);
    };

    const onInput = () => {
      lastInputAt = Date.now();
      if (yieldedRef.current) void resume();
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const name of events) window.addEventListener(name, onInput, true);

    const win = getCurrentWindow();
    void win.isFocused().then((f) => {
      if (disposed) return;
      focused = f;
      arm();
    });
    void win
      .onFocusChanged(({ payload }) => {
        focused = payload;
        if (focused) {
          lastInputAt = Date.now();
          void resume();
        }
        arm();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlistenFocus = fn;
      })
      .catch(() => {});
    void onDeviceGone(() => void handOver())
      .then((fn) => {
        if (disposed) fn();
        else unlistenGone = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, onInput, true);
      unlistenFocus?.();
      unlistenGone?.();
    };
  }, [handOver, resume]);

  const value: SyncSessionState = {
    conflictCopy,
    message,
    takenOverBy,
    yielded,
    preservedCopy,
    preserveCopy,
    takeBack,
    actionError,
  };

  return <SyncSessionContext.Provider value={value}>{children}</SyncSessionContext.Provider>;
}
