/**
 * Settings dialog (spec Section 15). Tabs: General, Page Templates, Editor,
 * Proofing, Refine, About. The left-nav shell makes each tab just an entry +
 * panel, wrapped in an ErrorBoundary that resets when the tab changes.
 */

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon, IconName } from "../ui/Icon";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { GeneralSettings } from "./GeneralSettings";
import { PageTemplatesManager } from "./PageTemplatesManager";
import { EditorSettings } from "./EditorSettings";
import { ProofingSettings } from "./ProofingSettings";
import { RefineSettings } from "./RefineSettings";
import { SyncSettings } from "./SyncSettings";
import { AboutSettings } from "./AboutSettings";
import { PausedWhileHeld } from "./PausedWhileHeld";
import * as api from "../../data/api";
import "./SettingsModal.css";

interface Tab {
  id: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { id: "general", label: "General", icon: "blue-folder" },
  { id: "templates", label: "Page Templates", icon: "card--pencil" },
  { id: "editor", label: "Editor", icon: "edit-family" },
  { id: "proofing", label: "Proofing", icon: "spell-check" },
  { id: "refine", label: "Refine", icon: "wand" },
  { id: "sync", label: "Sync", icon: "network-cloud" },
  { id: "about", label: "About", icon: "information" },
];

export function SettingsModal({
  open,
  initialTab = "general",
  onClose,
}: {
  open: boolean;
  initialTab?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  // Sync is unfinished and hidden in shipped builds. The backend owns the
  // decision so the tab can't drift out of step with the feature behind it.
  const [syncAvailable, setSyncAvailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .syncStatus()
      .then((s) => alive && setSyncAvailable(s.available))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  const tabs = TABS.filter((t) => t.id !== "sync" || syncAvailable);

  // When the dialog (re)opens, jump to the requested tab — e.g. Help ▸ About
  // opens straight to About. (The dialog stays mounted, so sync on open.)
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Modal title="Settings" open={open} onClose={onClose} width={1000}>
      <div className="v-settings">
        <nav className="v-settings__nav">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`v-settings__tab${t.id === tab ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="v-settings__panel">
          <ErrorBoundary label="This settings page" resetKeys={[tab]}>
            {/* Everything these panels change is persisted in app.json, which
                lives inside the Satchel (docs 5.7.1) — so they go inert while
                another device has it. General wraps itself, because its Satchel
                picker is machine-local and must stay usable. Sync and About
                change nothing inside the Satchel. */}
            {tab === "general" && <GeneralSettings />}
            {tab === "templates" && (
              <PausedWhileHeld>
                <PageTemplatesManager />
              </PausedWhileHeld>
            )}
            {tab === "editor" && (
              <PausedWhileHeld>
                <EditorSettings />
              </PausedWhileHeld>
            )}
            {tab === "proofing" && (
              <PausedWhileHeld>
                <ProofingSettings />
              </PausedWhileHeld>
            )}
            {tab === "refine" && (
              <PausedWhileHeld>
                <RefineSettings />
              </PausedWhileHeld>
            )}
            {tab === "sync" && syncAvailable && <SyncSettings />}
            {tab === "about" && <AboutSettings />}
          </ErrorBoundary>
        </div>
      </div>
    </Modal>
  );
}
