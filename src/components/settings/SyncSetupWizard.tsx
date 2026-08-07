/**
 * Sync setup (docs/satchels-and-sync.md).
 *
 * Configuring rclone by hand is miserable, and that misery is what this feature
 * exists to remove: the user picks a provider tile, fills a short form, and
 * everything else — the encryption wrapper, remote names, transfer flags — is
 * decided for them. rclone is never named.
 *
 * The last step is not decorative. With client-side encryption, losing the key
 * means the data is unrecoverable, so Finish stays disabled until the
 * connection code has been copied or saved.
 */

import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import * as api from "../../data/api";
import type { SyncProvider } from "../../data/types";
import "./SyncSettings.css";

type Step = "provider" | "form" | "code" | "paste";

export function SyncSetupWizard({
  open,
  onClose,
  onConfigured,
  onedriveConflict,
}: {
  open: boolean;
  onClose: () => void;
  onConfigured: () => void;
  /** The Satchel lives inside OneDrive; setting up sync needs an explicit
   *  acknowledgement first. */
  onedriveConflict: boolean;
}) {
  const [providers, setProviders] = useState<SyncProvider[]>([]);
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<SyncProvider | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [pasted, setPasted] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) api.syncProviders().then(setProviders).catch((e) => setError(String(e)));
  }, [open]);

  // Reset between openings so a cancelled setup never leaks into the next one.
  useEffect(() => {
    if (!open) {
      setStep("provider");
      setProvider(null);
      setValues({});
      setPath("");
      setPassphrase("");
      setPasted("");
      setCode("");
      setSaved(false);
      setCopied(false);
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  async function testAndSave() {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      // The backend performs a real write/read/delete round trip, so a
      // misconfigured remote can't be saved.
      await api.syncConfigure(provider.id, values, path);
      // Tell the panel now rather than at Finish: the remote is already saved,
      // and leaving "Set up sync…" showing behind the dialog reads as failure.
      onConfigured();
      setStep("code");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyCode() {
    setBusy(true);
    setError(null);
    try {
      await api.syncApplyConnectionCode(pasted, passphrase);
      onConfigured();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateCode() {
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

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setSaved(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function saveCodeToFile() {
    const target = await saveDialog({
      title: "Save your connection code",
      defaultPath: "vellum-connection-code.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof target !== "string") return;
    try {
      await api.syncWriteConnectionCode(target, passphrase);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
  }

  const title =
    step === "paste" ? "Use a connection code" : step === "code" ? "Save your connection code" : "Set up sync";

  return (
    <Modal title={title} open={open} onClose={onClose} width={560}>
      {step === "provider" && (
        <>
          <p className="v-set__hint">
            Vellum encrypts your notebooks before they leave this device, so the storage provider
            only ever sees scrambled files. Choose where to keep them.
          </p>
          {onedriveConflict && (
            <>
              <p className="v-set__hint v-set__hint--warn">
                This Satchel is inside a OneDrive folder. OneDrive and Vellum would both be
                syncing the same open notebooks, and OneDrive tends to resolve that by leaving
                duplicate &ldquo;copy&rdquo; files behind. Vellum&apos;s sync is meant to replace
                OneDrive for this folder, not run alongside it.
              </p>
              <label className="v-satchels__check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>
                  I understand, and I&apos;ll move this Satchel out of OneDrive or accept the
                  duplicates.
                </span>
              </label>
            </>
          )}
          <ul className="v-sync__tiles">
            {providers.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="v-sync__tile"
                  disabled={onedriveConflict && !acknowledged}
                  onClick={() => {
                    setProvider(p);
                    setValues({});
                    setPath("");
                    setStep("form");
                  }}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <p className="v-set__hint">
            Already set this up on another device?{" "}
            <button
              type="button"
              className="v-sync__link"
              disabled={onedriveConflict && !acknowledged}
              onClick={() => setStep("paste")}
            >
              Use a connection code
            </button>
          </p>
        </>
      )}

      {step === "form" && provider && (
        <>
          <p className="v-set__hint">{provider.label}</p>
          {provider.oauth && (
            <p className="v-set__hint">
              Choosing Connect opens {provider.label} in your browser to sign in. Vellum never
              sees your password, and your notebooks are still encrypted before they are uploaded
              — {provider.label} only ever holds scrambled files.
            </p>
          )}
          {provider.fields.map((f) => (
            <label key={f.key} className="v-sync__field">
              <span className="v-set__label">{f.label}</span>
              <input
                type={f.secret ? "password" : "text"}
                className="v-satchels__input"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              {f.hint && <span className="v-sync__hint">{f.hint}</span>}
            </label>
          ))}
          <label className="v-sync__field">
            <span className="v-set__label">{provider.pathLabel}</span>
            <input
              type="text"
              className="v-satchels__input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <span className="v-sync__hint">{provider.pathHint}</span>
          </label>
          {busy && provider.oauth && (
            <p className="v-set__hint">
              Waiting for you to finish signing in… Complete it in your browser, then come back.
            </p>
          )}
          {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
          <div className="v-sync__actions">
            <Button onClick={() => setStep("provider")} disabled={busy}>
              Back
            </Button>
            <Button accent onClick={() => void testAndSave()} disabled={busy || !path.trim()}>
              {busy ? (provider.oauth ? "Signing in…" : "Testing…") : provider.oauth ? "Connect" : "Test and continue"}
            </Button>
          </div>
        </>
      )}

      {step === "code" && (
        <>
          <p className="v-set__hint">
            This code is the only way to open this Satchel on another device. If you lose it and
            your passphrase, the synced notebooks cannot be recovered — not by us, not by your
            storage provider.
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
            <span className="v-sync__hint">
              Protects the code itself, so it is safe to email to yourself. You'll enter it on the
              other device.
            </span>
          </label>
          {!code && (
            <div className="v-sync__actions">
              <Button
                accent
                onClick={() => void generateCode()}
                disabled={busy || passphrase.length < 8}
              >
                {busy ? "Working…" : "Create the code"}
              </Button>
            </div>
          )}
          {code && (
            <>
              <textarea className="v-sync__code" readOnly value={code} rows={4} />
              <p className="v-sync__hint">
                Each code you create looks different, because it's encrypted afresh every time.
                They all open the same Satchel, so any copy you've saved keeps working.
              </p>
              <div className="v-sync__actions">
                <Button icon={copied ? "tick" : "clipboard-paste"} onClick={() => void copyCode()}>
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button icon="document-export" onClick={() => void saveCodeToFile()}>
                  Save to file…
                </Button>
              </div>
            </>
          )}
          {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
          <div className="v-sync__actions">
            <Button
              accent
              disabled={!saved}
              title={saved ? undefined : "Copy or save the code first"}
              onClick={() => {
                onConfigured();
                onClose();
              }}
            >
              Finish
            </Button>
          </div>
          {!saved && code && (
            <p className="v-set__hint">Copy or save the code to finish setting up.</p>
          )}
        </>
      )}

      {step === "paste" && (
        <>
          <p className="v-set__hint">
            Paste the connection code from the device you set up first, then enter the passphrase
            you chose there.
          </p>
          <textarea
            className="v-sync__code"
            value={pasted}
            rows={4}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="VELLUM-SYNC-1:…"
          />
          <label className="v-sync__field">
            <span className="v-set__label">Passphrase</span>
            <input
              type="password"
              className="v-satchels__input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          {error && <p className="v-set__hint v-set__hint--error">{error}</p>}
          <div className="v-sync__actions">
            <Button onClick={() => setStep("provider")} disabled={busy}>
              Back
            </Button>
            <Button
              accent
              onClick={() => void applyCode()}
              disabled={busy || !pasted.trim() || passphrase.length < 8}
            >
              {busy ? "Checking…" : "Connect"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
