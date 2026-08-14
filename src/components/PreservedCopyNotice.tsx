/**
 * Where the opening pull put the work it was about to replace (docs 5.5).
 *
 * The pull preserves a copy whenever this device has unsent work — on an
 * ordinary launch, and again when a take-over on arrival finally gets to pull.
 * Until now the path was reported to the window and never shown, so a folder
 * appeared beside the Satchel with nobody to explain it. Same sentence the
 * lost-lease bar uses for the copy it makes, because it is the same thing.
 */

import { useSyncSession } from "../state/syncSession";
import "./PreservedCopyNotice.css";

export function PreservedCopyNotice() {
  const { conflictCopy } = useSyncSession();

  if (!conflictCopy) return null;

  return (
    <div className="v-preserved" role="status" aria-live="polite">
      A copy of your unsent changes was saved to <code>{conflictCopy}</code> — open it like
      any other Satchel.
    </div>
  );
}
