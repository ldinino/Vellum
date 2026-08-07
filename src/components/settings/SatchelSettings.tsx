/**
 * Settings → General ▸ Satchels. A Satchel is a self-contained data root
 * (notebooks, attachments, settings); a user can keep several and switch
 * between them. Switching relaunches the app rather than hot-swapping, so no
 * cache, pool or asset-protocol scope has to be invalidated.
 *
 * There is deliberately no "move my data" action any more: to relocate a
 * Satchel you close Vellum, move the folder in Explorer, and Open… it again.
 * The marker file's stable id means the moved folder is recognised as the same
 * Satchel rather than added twice.
 */

import { useCallback, useEffect, useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { useActiveEditor } from "../../state/activeEditor";
import * as api from "../../data/api";
import type { SatchelInfo } from "../../data/types";
import "./SettingsPanels.css";

/** Backend sentinel for "that folder has no satchel.json". */
const NOT_A_SATCHEL = "NOT_A_SATCHEL";

export function SatchelSettings() {
  const [satchels, setSatchels] = useState<SatchelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ parent: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [copySettings, setCopySettings] = useState(true);
  const { active } = useActiveEditor();

  const refresh = useCallback(
    () => api.listSatchels().then(setSatchels).catch((e) => setError(String(e))),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Persist the open page, record the choice, and restart into it. */
  async function switchTo(satchel: SatchelInfo) {
    if (satchel.active || busy) return;
    const ok = await ask(`Vellum will restart to open "${satchel.name}".`, {
      title: "Switch Satchel",
      kind: "info",
    });
    if (!ok) return;
    await activate(satchel);
  }

  async function activate(satchel: SatchelInfo) {
    setBusy(true);
    setError(null);
    try {
      // flushSaves is absent when no editor is mounted, hence Promise.resolve.
      await Promise.resolve(active?.flushSaves()).catch(() => {});
      await api.setActiveSatchel(satchel.id);
      await relaunch();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function openExisting() {
    const dir = await openDialog({ directory: true, title: "Open a Satchel" });
    if (typeof dir !== "string") return;
    setError(null);
    try {
      await finishOpen(await api.openSatchel(dir));
    } catch (e) {
      if (!String(e).includes(NOT_A_SATCHEL)) {
        setError(String(e));
        return;
      }
      const adopt = await ask(
        `That folder isn't a Satchel yet.\n\n${dir}\n\nCreate one there? Any notebooks already in the folder will be picked up.`,
        { title: "Not a Satchel", kind: "warning" },
      );
      if (!adopt) return;
      try {
        await finishOpen(await api.openSatchel(dir, true));
      } catch (e2) {
        setError(String(e2));
      }
    }
  }

  /** Opening means opening: switch to it, restarting as usual. The list is
   *  refreshed first so the new row is there if the restart is declined. */
  async function finishOpen(opened: SatchelInfo) {
    await refresh();
    const ok = await ask(`Vellum will restart to open "${opened.name}".`, {
      title: "Open Satchel",
      kind: "info",
    });
    if (!ok) return;
    await activate(opened);
  }

  async function pickParentForNew() {
    const parent = await openDialog({
      directory: true,
      title: "Choose where to create the Satchel",
    });
    if (typeof parent !== "string") return;
    setNewName("");
    setCopySettings(true);
    setCreating({ parent });
  }

  async function confirmCreate() {
    if (!creating || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSatchel(creating.parent, newName, copySettings);
      setCreating(null);
      await refresh();
      setBusy(false);
      await switchTo(created);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function forget(satchel: SatchelInfo) {
    setError(null);
    try {
      await api.forgetSatchel(satchel.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="v-set__section">
      <h3 className="v-set__heading">Satchels</h3>
      <p className="v-set__hint">
        A Satchel holds your notebooks, attachments and settings. Keep as many as you like — one
        for work, one for testing — and switch between them; Vellum restarts to open a different
        one. To move a Satchel, close Vellum, move the folder, then open it again.
      </p>

      <ul className="v-satchels">
        {satchels.map((s) => (
          <li
            key={s.id}
            className={`v-satchels__row${s.active ? " v-satchels__row--active" : ""}`}
          >
            <button
              type="button"
              className="v-satchels__pick"
              onClick={() => void switchTo(s)}
              disabled={busy}
              aria-current={s.active || undefined}
              title={s.active ? "Currently open" : `Restart Vellum and open "${s.name}"`}
            >
              <Icon name={s.sync ? "network-cloud" : "drive"} />
              <span className="v-satchels__name">{s.name}</span>
              {s.active && <span className="v-satchels__badge">In use</span>}
              {s.missing && <span className="v-satchels__badge">Can't be found</span>}
              <span className="v-satchels__path">{s.path}</span>
            </button>
            <button
              type="button"
              className="v-satchels__forget"
              onClick={() => void forget(s)}
              disabled={s.active}
              aria-label={`Remove ${s.name} from this list`}
              title="Remove from this list. The folder and its notebooks are not deleted."
            />
          </li>
        ))}
      </ul>

      <div className="v-set__pathrow">
        <Button icon="blue-folder--arrow" onClick={() => void openExisting()} disabled={busy}>
          Open…
        </Button>
        <Button icon="blue-folder--plus" onClick={() => void pickParentForNew()} disabled={busy}>
          New Satchel…
        </Button>
        <Button icon="blue-folder" onClick={() => void api.revealDataDir()} disabled={busy}>
          Open folder
        </Button>
      </div>
      {error && <p className="v-set__hint v-set__hint--error">{error}</p>}

      <Modal
        title="New Satchel"
        open={creating !== null}
        onClose={() => setCreating(null)}
        width={460}
        footer={
          <>
            <Button onClick={() => setCreating(null)}>Cancel</Button>
            <Button accent onClick={() => void confirmCreate()} disabled={!newName.trim() || busy}>
              Create
            </Button>
          </>
        }
      >
        <p className="v-set__hint">
          A folder will be created in <code>{creating?.parent}</code>.
        </p>
        <label className="v-set__field">
          <span className="v-set__label">Name</span>
          <input
            type="text"
            className="v-satchels__input"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void confirmCreate()}
          />
        </label>
        <label className="v-satchels__check">
          <input
            type="checkbox"
            checked={copySettings}
            onChange={(e) => setCopySettings(e.target.checked)}
          />
          <span>
            Copy settings from the Satchel I'm using now — appearance, proofing, templates and
            dictionary. Notebooks are never copied.
          </span>
        </label>
      </Modal>
    </section>
  );
}
