/**
 * Settings → About (spec Section 15): app + component versions and (deferred)
 * update check. In-app updates are wired in Phase 11 once the minisign keypair
 * exists (see CLAUDE.md), so the check is a disabled placeholder for now.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/Button";
import * as api from "../../data/api";
import type { LogEntry, VersionInfo } from "../../data/types";
import "./SettingsPanels.css";

export function AboutSettings() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let active = true;
    api
      .getVersionInfo()
      .then((v) => active && setInfo(v))
      .catch(() => {
        /* leave the placeholders showing */
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshLogs = useCallback(() => {
    api.getAppLog().then(setLogs).catch(() => {});
  }, []);
  // Load the log when the panel opens, then poll so new lines appear live.
  useEffect(() => {
    refreshLogs();
    const id = window.setInterval(refreshLogs, 2000);
    return () => window.clearInterval(id);
  }, [refreshLogs]);

  // Tail the newest line (console-style), but don't yank the user back down
  // while they're scrolled up reading history.
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const exportLogs = async () => {
    try {
      const path = await save({
        defaultPath: "vellum-log.txt",
        filters: [{ name: "Log", extensions: ["txt", "log"] }],
      });
      if (path) await api.exportAppLog(path);
    } catch (e) {
      console.error("export logs failed", e);
    }
  };

  const clearLogs = async () => {
    try {
      await api.clearAppLog();
      setLogs([]);
    } catch (e) {
      console.error("clear logs failed", e);
    }
  };

  return (
    <div className="v-set">
      <section className="v-set__section">
        <h3 className="v-set__heading">Vellum</h3>
        <dl className="v-set__versions">
          <div className="v-set__ver">
            <dt>Version</dt>
            <dd>{info?.app ?? "…"}</dd>
          </div>
          <div className="v-set__ver">
            <dt>Grammar (Harper)</dt>
            <dd>{info?.harper ?? "…"}</dd>
          </div>
          <div className="v-set__ver">
            <dt>Refine runtime (Ollama)</dt>
            <dd>{info?.ollama ?? "…"}</dd>
          </div>
        </dl>
      </section>

      <section className="v-set__section">
        <h3 className="v-set__heading">Updates</h3>
        <p className="v-set__hint">
          In-app updates aren&apos;t available in this build yet — they turn on with the first
          public release.
        </p>
        <div>
          <Button
            icon="arrow-circle-double"
            disabled
            title="Available after the first release"
          >
            Check for updates
          </Button>
        </div>
      </section>

      <section className="v-set__section">
        <h3 className="v-set__heading">Diagnostics</h3>
        <p className="v-set__hint">
          Recent app events and errors. Logs stay on your computer; export them if you need to
          report a problem.
        </p>
        <div className="v-set__logtoolbar">
          <Button icon="arrow-circle-double" onClick={refreshLogs}>
            Refresh
          </Button>
          <Button icon="document-export" onClick={() => void exportLogs()}>
            Export logs…
          </Button>
          <Button icon="eraser" onClick={() => void clearLogs()} disabled={logs.length === 0}>
            Clear
          </Button>
        </div>
        <div className="v-set__log" role="log" ref={logRef} onScroll={onLogScroll}>
          {logs.length === 0 ? (
            <p className="v-set__hint">No log entries yet.</p>
          ) : (
            logs.slice(-500).map((e, i) => (
              <div key={i} className={`v-set__logrow v-set__logrow--${e.level}`}>
                <span className="v-set__logtime">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className={`v-set__loglevel v-set__loglevel--${e.level}`}>{e.level}</span>
                <span className="v-set__logarea">{e.area}</span>
                <span className="v-set__logmsg">{e.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="v-set__section">
        <h3 className="v-set__heading">Acknowledgements</h3>
        <p className="v-set__hint">
          Window chrome adapted from <strong>7.css</strong> (MIT). Icons from the{" "}
          <strong>Fugue</strong> set by Yusuke Kamiyamane (CC BY 3.0). Grammar and spelling by{" "}
          <strong>Harper</strong> (Apache-2.0). Refine runs on <strong>Ollama</strong> (MIT).
        </p>
      </section>

      <section className="v-set__section">
        <h3 className="v-set__heading">License</h3>
        <p className="v-set__hint">
          © 2026 Luciano DiNino. Vellum is released under the MIT License. Bundled assets and
          software are licensed separately; see THIRD-PARTY-NOTICES.md.
        </p>
      </section>

      <section className="v-set__section">
        <h3 className="v-set__heading">Disclaimer</h3>
        <p className="v-set__hint">
          Vellum is an independent project and is not affiliated with, endorsed by, or sponsored
          by Microsoft. OneNote, Windows, Office, OneDrive, and Segoe UI are trademarks of
          Microsoft Corporation.
        </p>
      </section>
    </div>
  );
}
