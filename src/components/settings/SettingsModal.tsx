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
import { AboutSettings } from "./AboutSettings";
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

  // When the dialog (re)opens, jump to the requested tab — e.g. Help ▸ About
  // opens straight to About. (The dialog stays mounted, so sync on open.)
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Modal title="Settings" open={open} onClose={onClose} width={1000}>
      <div className="v-settings">
        <nav className="v-settings__nav">
          {TABS.map((t) => (
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
            {tab === "general" && <GeneralSettings />}
            {tab === "templates" && <PageTemplatesManager />}
            {tab === "editor" && <EditorSettings />}
            {tab === "proofing" && <ProofingSettings />}
            {tab === "refine" && <RefineSettings />}
            {tab === "about" && <AboutSettings />}
          </ErrorBoundary>
        </div>
      </div>
    </Modal>
  );
}
