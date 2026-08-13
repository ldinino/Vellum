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

  // Taking it over is a take-over in the other direction, so it carries the
  // same warning section 2 gives the first one.
  async function confirmTakeBack() {
    const ok = await ask(
      `This Satchel is open on ${takenOverBy}.\n\nTaking it over means anything unsaved there may be lost.\n\nTake over anyway?`,
      { title: "Satchel in use", kind: "warning" },
    );
    if (ok) await takeBack();
  }

  return (
    <div className="v-standdown" role="status" aria-live="polite">
      <div className="v-standdown__text">
        <strong className="v-standdown__title">This Satchel is open on {takenOverBy}.</strong>{" "}
        Editing is paused here.
        {preservedCopy && (
          <>
            {" "}
            A copy of your unsent changes was saved to <code>{preservedCopy}</code> — open it
            like any other Satchel.
          </>
        )}
        {actionError && <span className="v-standdown__error"> {actionError}</span>}
      </div>
      <div className="v-standdown__actions">
        {!preservedCopy && (
          <Button icon="disk" onClick={() => void run(preserveCopy)} disabled={busy}>
            Save a copy here
          </Button>
        )}
        <Button icon="network-cloud" onClick={() => void run(confirmTakeBack)} disabled={busy}>
          Take over
        </Button>
      </div>
    </div>
  );
}
