/**
 * Settings → General (spec Section 15): the app data location. Shows where
 * Vellum stores its data (default `Documents\Vellum`, which OneDrive syncs) and
 * lets the user move it to a folder of their choice — e.g. a local, non-synced
 * folder so OneDrive stops making duplicate copies of the live databases and
 * search index. Changing it moves the data, then restarts the app so everything
 * reloads from the new location.
 */

import { useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "../ui/Button";
import { useActiveEditor } from "../../state/activeEditor";
import * as api from "../../data/api";
import "./SettingsPanels.css";

export function GeneralSettings() {
  const [currentPath, setCurrentPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { active } = useActiveEditor();

  useEffect(() => {
    let alive = true;
    api
      .getPaths()
      .then((p) => alive && setCurrentPath(p.dataDir))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Pick a new parent folder, move the data into `<parent>\Vellum`, then restart
  // so the app reloads everything from the new location.
  async function changeLocation() {
    const parent = await open({
      directory: true,
      title: "Choose where to store Vellum data",
    });
    if (typeof parent !== "string") return;

    const ok = await ask(
      `Vellum will move all your notebooks and settings to:\n\n${parent}\\Vellum\n\nThe app will restart to finish. Continue?`,
      { title: "Change data location", kind: "warning" },
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      // Persist the open page before its database is moved (flushSaves is absent
      // when no editor is mounted, hence Promise.resolve).
      await Promise.resolve(active?.flushSaves()).catch(() => {});
      const newPath = await api.setDataDir(parent);
      // Picking the current location is a no-op — no need to restart.
      if (newPath === currentPath) {
        setBusy(false);
        return;
      }
      await relaunch();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">App data location</h3>
        <p className="v-set__hint">
          Your notebooks, attachments, and settings are stored here. On Windows this folder is
          backed up by OneDrive automatically. You can move it elsewhere — for example, a folder
          outside OneDrive — to stop OneDrive from making duplicate copies of open notebooks.
        </p>
        <div className="v-set__pathrow">
          <code className="v-set__path">{currentPath || (error ? "Unavailable" : "…")}</code>
          <Button
            icon="blue-folder"
            onClick={() => void api.revealDataDir()}
            disabled={!currentPath || busy}
          >
            Open folder
          </Button>
          <Button
            icon="blue-folder--arrow"
            onClick={() => void changeLocation()}
            disabled={!currentPath || busy}
          >
            {busy ? "Moving…" : "Change…"}
          </Button>
        </div>
        {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
      </section>
    </div>
  );
}
