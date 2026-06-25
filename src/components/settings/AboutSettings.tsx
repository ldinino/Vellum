/**
 * Settings → About (spec Section 15): app + component versions and (deferred)
 * update check. In-app updates are wired in Phase 11 once the minisign keypair
 * exists (see CLAUDE.md), so the check is a disabled placeholder for now.
 */

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import * as api from "../../data/api";
import type { VersionInfo } from "../../data/types";
import "./SettingsPanels.css";

export function AboutSettings() {
  const [info, setInfo] = useState<VersionInfo | null>(null);

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
        <h3 className="v-set__heading">Acknowledgements</h3>
        <p className="v-set__hint">
          Window chrome adapted from <strong>7.css</strong> (MIT). Icons from the{" "}
          <strong>Fugue</strong> set by Yusuke Kamiyamane (CC BY 3.0). Grammar and spelling by{" "}
          <strong>Harper</strong> (Apache-2.0). Refine runs on <strong>Ollama</strong> (MIT).
        </p>
      </section>
    </div>
  );
}
