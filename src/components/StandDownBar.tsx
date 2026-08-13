/**
 * Shown for the rest of the session once another device takes the Satchel over
 * (docs/satchels-and-sync.md 5.1).
 *
 * A bar rather than a modal, deliberately. The take-over arrives on a timer,
 * which means it usually lands while this window is in the background: a modal
 * would then be a trap waiting behind another app, stealing the first click and
 * losing the place in the notes. The bar states the situation, stays until it
 * is dealt with, and leaves both ways out visible.
 */

import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "./ui/Button";
import { useSyncSession } from "../state/syncSession";
import "./StandDownBar.css";

export function StandDownBar() {
  const { takenOverBy, preservedCopy, preserveCopy, takeBack, actionError } = useSyncSession();
  const [busy, setBusy] = useState(false);

  if (!takenOverBy) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  // Taking it back is a take-over in the other direction, so it carries the
  // same warning section 2 gives the first one.
  async function confirmTakeBack() {
    const ok = await ask(
      `${takenOverBy} is using this Satchel right now.\n\nTaking it back means anything unsaved on that device may be lost.\n\nTake it back anyway?`,
      { title: "Take the Satchel back", kind: "warning" },
    );
    if (ok) await takeBack();
  }

  return (
    <div className="v-standdown" role="status" aria-live="polite">
      <div className="v-standdown__text">
        <strong className="v-standdown__title">{takenOverBy} is using this Satchel now.</strong>{" "}
        Editing is paused here and nothing will be sent to your storage, so the two devices
        can&apos;t write over each other. Your notebooks on this device are untouched.
        {preservedCopy && (
          <>
            {" "}
            A copy of the work from this session was saved to <code>{preservedCopy}</code> — open
            it like any other Satchel.
          </>
        )}
        {actionError && <span className="v-standdown__error"> {actionError}</span>}
      </div>
      <div className="v-standdown__actions">
        {!preservedCopy && (
          <Button icon="disk" onClick={() => void run(preserveCopy)} disabled={busy}>
            Keep a copy of this session
          </Button>
        )}
        <Button icon="network-cloud" onClick={() => void run(confirmTakeBack)} disabled={busy}>
          Take it back
        </Button>
      </div>
    </div>
  );
}
