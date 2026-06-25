/**
 * Settings → General (spec Section 15): the app data location. Read-only — the
 * path is fixed at `Documents\Vellum` (Section 4) so it can be OneDrive-synced;
 * we just surface it and offer to open the folder.
 */

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import * as api from "../../data/api";
import "./SettingsPanels.css";

export function GeneralSettings() {
  const [dataDir, setDataDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getPaths()
      .then((p) => active && setDataDir(p.dataDir))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">App data location</h3>
        <p className="v-set__hint">
          Your notebooks, attachments, and settings are stored here. On Windows this folder is
          backed up by OneDrive automatically.
        </p>
        <div className="v-set__pathrow">
          <code className="v-set__path">{dataDir || (error ? "Unavailable" : "…")}</code>
          <Button icon="blue-folder" onClick={() => void api.revealDataDir()} disabled={!dataDir}>
            Open folder
          </Button>
        </div>
        {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
      </section>
    </div>
  );
}
