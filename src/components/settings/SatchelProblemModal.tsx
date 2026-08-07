/**
 * Shown at startup when the active Satchel can't be opened — its folder is gone
 * (disconnected drive, cloud folder that hasn't downloaded yet), or it was
 * written by a newer Vellum. Blocking and undismissable on purpose: we never
 * silently fall back to a fresh empty data root, because that reads as data
 * loss.
 */

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import * as api from "../../data/api";
import type { SatchelProblem } from "../../data/types";
import "./SettingsPanels.css";

export function SatchelProblemModal() {
  const [problem, setProblem] = useState<SatchelProblem | null>(null);
  const [naming, setNaming] = useState<{ parent: string } | null>(null);
  const [name, setName] = useState("Vellum");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSatchelProblem().then(setProblem).catch(() => {});
  }, []);

  if (!problem) return null;

  async function activateAndRestart(id: string) {
    await api.setActiveSatchel(id);
    await relaunch();
  }

  async function openExisting() {
    const dir = await openDialog({ directory: true, title: "Open a Satchel" });
    if (typeof dir !== "string") return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.openSatchel(dir, true);
      await activateAndRestart(s.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function pickParent() {
    const parent = await openDialog({
      directory: true,
      title: "Choose where to create the Satchel",
    });
    if (typeof parent !== "string") return;
    setName("Vellum");
    setNaming({ parent });
  }

  async function create() {
    if (!naming || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSatchel(naming.parent, name, false);
      await activateAndRestart(s.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const missing = problem.kind === "missing";

  return (
    <Modal
      title={missing ? "Satchel not found" : "Satchel is too new"}
      open
      onClose={() => {}}
      width={520}
      footer={
        <>
          <Button onClick={() => void exit(0)}>Quit</Button>
          {missing && (
            <Button onClick={() => void pickParent()} disabled={busy}>
              New Satchel…
            </Button>
          )}
          <Button accent onClick={() => void openExisting()} disabled={busy}>
            Open a Satchel…
          </Button>
        </>
      }
    >
      {missing ? (
        <p className="v-set__hint">
          Vellum can't find the Satchel <strong>{problem.name}</strong>. It may be on a drive
          that isn't connected, or in a synced folder that hasn't downloaded yet. Nothing has been
          changed or deleted — if you reconnect the folder and restart, it will open as usual.
        </p>
      ) : (
        <p className="v-set__hint">
          The Satchel <strong>{problem.name}</strong> was made by a newer version of Vellum.
          Update Vellum to open it.
        </p>
      )}
      <p className="v-set__pathrow">
        <code className="v-set__path">{problem.path}</code>
      </p>

      {naming && (
        <label className="v-set__field">
          <span className="v-set__label">Name the new Satchel</span>
          <input
            type="text"
            className="v-satchels__input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <Button accent onClick={() => void create()} disabled={!name.trim() || busy}>
            Create in {naming.parent}
          </Button>
        </label>
      )}
      {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
    </Modal>
  );
}
