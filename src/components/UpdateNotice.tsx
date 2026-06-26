/**
 * Non-blocking "an update is ready" prompt (Phase 11). Appears once the
 * background download finishes; the user keeps working until they choose to
 * restart. "Later" hides it for this session (the next launch re-checks).
 * Reflects the same state shown in Settings ▸ About.
 */

import { useState } from "react";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { useUpdater } from "../state/updater";
import "./UpdateNotice.css";

export function UpdateNotice() {
  const { status, applyUpdate } = useUpdater();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  if (status.kind !== "ready") return null;
  if (dismissedVersion === status.version) return null;

  return (
    <div className="v-update" role="status">
      <Icon name="arrow-circle-double" className="v-update__icon" />
      <span className="v-update__text">
        Vellum {status.version} is ready to install.
      </span>
      <Button
        accent
        disabled={restarting}
        onClick={() => {
          setRestarting(true);
          void applyUpdate();
        }}
      >
        {restarting ? "Restarting…" : "Restart now"}
      </Button>
      <Button
        className="v-update__later"
        disabled={restarting}
        onClick={() => setDismissedVersion(status.version)}
      >
        Later
      </Button>
    </div>
  );
}
