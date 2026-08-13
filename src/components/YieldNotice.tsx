/**
 * Shown while this device has handed the Satchel back (docs 5.2).
 *
 * Deliberately not the take-over bar: nothing is wrong, nothing is paused, and
 * there is nothing to decide. It is a line of status, not a demand — one
 * sentence, no buttons, and it disappears the moment the person types.
 */

import { useSyncSession } from "../state/syncSession";
import "./YieldNotice.css";

export function YieldNotice() {
  const { yielded, takenOverBy } = useSyncSession();

  // A take-over is the louder situation and has its own bar; two notices about
  // the same Satchel would be one too many.
  if (!yielded || takenOverBy) return null;

  return (
    <div className="v-yielded" role="status" aria-live="polite">
      This Satchel is free for your other devices. Carry on typing to use it here.
    </div>
  );
}
