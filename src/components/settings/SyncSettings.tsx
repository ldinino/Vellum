/**
 * Settings → Sync. Scoped to the active Satchel: sync covers the whole Satchel,
 * settings included, which is what makes a synced Satchel arrive on another
 * machine already configured.
 */

import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { SyncSetupWizard } from "./SyncSetupWizard";
import * as api from "../../data/api";
import type { SyncStatus } from "../../data/types";
import "./SyncSettings.css";

function whenLabel(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Never";
  return then.toLocaleString();
}

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () => api.syncStatus().then(setStatus).catch((e) => setError(String(e))),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function syncNow() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      let report = await api.syncNow(false).catch(async (e) => {
        // Another device holds the lease; taking over is the user's call, never
        // an assumption.
        if (!String(e).includes("is using this Satchel")) throw e;
        const ok = await ask(`${String(e)}\n\nTake over anyway?`, {
          title: "Satchel in use",
          kind: "warning",
        });
        if (!ok) return null;
        return api.syncNow(true);
      });
      if (!report) return;
      if (report.conflictCopy) {
        setNote(
          `Another device had already synced newer changes. Your copy was saved to ${report.conflictCopy} — nothing was overwritten.`,
        );
      } else if (report.skipped.length > 0) {
        setNote(`Synced. Some notebooks were copied as they were: ${report.skipped.join("; ")}`);
      } else {
        setNote("Synced.");
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopSync() {
    const ok = await ask(
      "Vellum will stop syncing this Satchel on this device.\n\nYour notebooks stay here, and the copy already in your storage is left untouched.",
      { title: "Stop syncing", kind: "warning" },
    );
    if (!ok) return;
    try {
      await api.syncStop();
      setNote(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function makeCode() {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.syncConnectionCode(passphrase));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">Sync</h3>
        <p className="v-set__hint">
          Keep this Satchel — notebooks, attachments and settings — in storage you control.
          Everything is encrypted on this device first, so the provider only ever holds scrambled
          files. Vellum syncs when you open and close the Satchel, and whenever you ask.
        </p>

        {status?.error && (
          <p className="v-set__hint v-set__hint--error">
            This Satchel has sync settings that can't be read on this machine or user account.
            Set it up again, or use a connection code. ({status.error})
          </p>
        )}

        {status && !status.configured && (
          <div className="v-set__pathrow">
            <Button icon="network-cloud" onClick={() => setWizardOpen(true)}>
              Set up sync…
            </Button>
          </div>
        )}

        {status?.configured && !status.error && (
          <>
            <dl className="v-sync__facts">
              <dt>Storage</dt>
              <dd>{status.label ?? "Configured"}</dd>
              <dt>Last synced</dt>
              <dd>{whenLabel(status.lastSyncedAt)}</dd>
              {status.heldBy && (
                <>
                  <dt>In use</dt>
                  <dd>
                    {status.heldBy}
                    {status.heldSince ? ` since ${whenLabel(status.heldSince)}` : ""}
                  </dd>
                </>
              )}
            </dl>
            <div className="v-set__pathrow">
              <Button icon="arrow-circle-double" onClick={() => void syncNow()} disabled={busy}>
                {busy ? "Syncing…" : "Sync now"}
              </Button>
              <Button
                icon="clipboard-paste"
                onClick={() => {
                  setCode("");
                  setPassphrase("");
                  setCodeOpen(true);
                }}
              >
                Copy connection code…
              </Button>
              <Button icon="cross" onClick={() => void stopSync()} disabled={busy}>
                Stop syncing
              </Button>
            </div>
          </>
        )}

        {note && <p className="v-set__hint">{note}</p>}
        {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
      </section>

      <SyncSetupWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConfigured={() => void refresh()}
      />

      <Modal
        title="Connection code"
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        width={560}
      >
        <p className="v-set__hint">
          Use this on another device to open the same Satchel. Choose a passphrase to protect it —
          you'll enter the same one there.
        </p>
        <label className="v-sync__field">
          <span className="v-set__label">Passphrase</span>
          <input
            type="password"
            className="v-satchels__input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="At least 8 characters"
          />
        </label>
        {!code ? (
          <div className="v-sync__actions">
            <Button accent onClick={() => void makeCode()} disabled={busy || passphrase.length < 8}>
              {busy ? "Working…" : "Create the code"}
            </Button>
          </div>
        ) : (
          <>
            <textarea className="v-sync__code" readOnly value={code} rows={4} />
            <p className="v-sync__hint">
              Each code you create looks different, because it's encrypted afresh every time. They
              all open the same Satchel, so any copy you've saved keeps working.
            </p>
            <div className="v-sync__actions">
              <Button
                icon={copied ? "tick" : "clipboard-paste"}
                onClick={async () => {
                  await navigator.clipboard.writeText(code);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </>
        )}
        {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
      </Modal>
    </div>
  );
}
