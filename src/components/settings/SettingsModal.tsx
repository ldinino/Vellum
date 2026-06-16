/**
 * Settings dialog (spec Section 14). Phase 6 ships the Templates → Page
 * Templates section; the remaining sections (General, Editor, Grammar, Refine,
 * About) are filled in by Phase 8. The left-nav shell is here so adding them is
 * just another entry + panel.
 */

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon, IconName } from "../ui/Icon";
import { PageTemplatesManager } from "./PageTemplatesManager";
import { RefineSettings } from "./RefineSettings";
import "./SettingsModal.css";

interface Tab {
  id: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { id: "templates", label: "Page Templates", icon: "card--pencil" },
  { id: "refine", label: "Refine", icon: "wand" },
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState("templates");

  return (
    <Modal title="Settings" open={open} onClose={onClose} width={840}>
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
          {tab === "templates" && <PageTemplatesManager />}
          {tab === "refine" && <RefineSettings />}
        </div>
      </div>
    </Modal>
  );
}
