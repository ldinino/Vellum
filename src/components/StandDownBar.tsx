/**
 * Shown for the rest of the session once this window loses the Satchel to
 * another device (docs/satchels-and-sync.md 5.1) — either because one took it
 * over while we were open, or because one already had it when we opened
 * (5.5). From here the two are the same situation: somebody else is writing,
 * this window is not, and the ways out are identical.
 *
 * A bar rather than a modal, deliberately. The take-over arrives on a timer,
 * which means it usually lands while this window is in the background: a modal
 * would then be a trap waiting behind another app, stealing the first click and
 * losing the place in the notes. The bar states the situation, stays until it
 * is dealt with, and leaves both ways out visible. The arrival case keeps the
 * bar for the same reason plus one of its own — a modal on launch would block
 * reading notes the user can perfectly well read.
 */

import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "./ui/Button";
import { useSyncSession } from "../state/syncSession";
import "./StandDownBar.css";

export function StandDownBar() {
  const { takenOverBy, heldBy, preservedCopy, preserveCopy, takeBack, actionError } =
    useSyncSession();
  const [busy, setBusy] = useState(false);

  // A take-over is the more recent news, so it wins if somehow both are set.
  const holder = takenOverBy ?? heldBy;
  // Nothing was pulled on arrival, so what is on screen is this device's own
  // last copy. Saying so is the difference between the two cases.
  const stale = takenOverBy === null && heldBy !== null;

  if (!holder) return null;

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
      `This Satchel is open on ${holder}.\n\nTaking it over means anything unsaved there may be lost.\n\nTake over anyway?`,
      { title: "Satchel in use", kind: "warning" },
    );
    if (ok) await takeBack();
  }

  return (
    <div className="v-standdown" role="status" aria-live="polite">
      <div className="v-standdown__text">
        <strong className="v-standdown__title">This Satchel is open on {holder}.</strong>{" "}
        Editing is paused here.
        {stale && <> It hasn't been updated from your storage.</>}
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
