/**
 * Settings that live inside the Satchel, disabled while another device has it
 * (docs/satchels-and-sync.md 5.7.1).
 *
 * `app.json` is inside the Satchel and travels with it, so a theme or a
 * dictionary word changed while another device holds it would land in the
 * preserved fork rather than the live Satchel. The backend refuses these saves;
 * this is what stops the user meeting that refusal from a dialog that looked
 * perfectly willing.
 *
 * Wrapping the panel rather than disabling each control is deliberate: a new
 * setting is then covered by default, which is the same reason the guard went
 * in the backend rather than in each action.
 */

import { ReactNode } from "react";
import { useSyncSession } from "../../state/syncSession";
import "./SettingsPanels.css";

export function PausedWhileHeld({ children }: { children: ReactNode }) {
  const { readOnly, heldBy, takenOverBy } = useSyncSession();
  const holder = takenOverBy ?? heldBy;

  if (!readOnly) return <>{children}</>;

  return (
    <div className="v-paused">
      <p className="v-paused__notice" role="status">
        {holder ? `This Satchel is open on ${holder}.` : "This Satchel is open on another device."}{" "}
        These settings are stored inside the Satchel, so they're paused here until you take it
        back.
      </p>
      <div className="v-paused__body" inert>
        {children}
      </div>
    </div>
  );
}
