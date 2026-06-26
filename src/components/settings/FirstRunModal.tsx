/**
 * First-run setup screen (spec Section 9 / Phase 7). Shown once, on first
 * launch. The Enable Refine toggle is the first option and is OFF by default;
 * we also show a hardware summary and the tier we'd recommend. Finishing (or
 * dismissing) marks setup complete so it never reappears.
 */

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Toggle";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import type { DetectedHardware } from "../../data/types";
import "./FirstRunModal.css";

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`;
  return `${n} B`;
}

export function FirstRunModal() {
  const { configLoaded, firstRunComplete, actions } = useVellum();
  const [enable, setEnable] = useState(false);
  const [hardware, setHardware] = useState<DetectedHardware | null>(null);
  const [finishing, setFinishing] = useState(false);

  const open = configLoaded && !firstRunComplete;

  useEffect(() => {
    if (open) api.refineDetectHardware().then(setHardware).catch(() => {});
  }, [open]);

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      if (enable) await actions.setRefineEnabled(true);
      await actions.completeFirstRun(enable ? hardware?.recommendedTier ?? null : null);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <Modal
      title="Welcome to Vellum"
      open={open}
      onClose={finish}
      width={520}
      footer={
        <Button accent onClick={finish} disabled={finishing}>
          Get started
        </Button>
      }
    >
      <div className="v-firstrun">
        <p className="v-firstrun__intro">
          Vellum keeps everything on your machine. You can optionally enable{" "}
          <strong>Refine</strong> — a local tool that reshapes selected text into a format you
          choose, like meeting notes or action items, using a model that runs entirely offline.
        </p>

        <div className="v-firstrun__toggle">
          <Toggle checked={enable} onChange={setEnable} label="Enable Refine" />
        </div>

        <div className="v-firstrun__hw">
          {hardware ? (
            <>
              <div>
                {formatBytes(hardware.totalRamBytes)} RAM ·{" "}
                {hardware.gpuKind === "none"
                  ? "no GPU detected"
                  : `${hardware.gpus.find((g) => !g.isBasicRenderDriver)?.description ?? "GPU"} (${hardware.gpuKind})`}
              </div>
              <div>
                Recommended tier on this machine: <strong>{hardware.recommendedTier}</strong>
              </div>
              {hardware.warning && <div className="v-firstrun__warn">⚠ {hardware.warning}</div>}
            </>
          ) : (
            <div>Checking your hardware…</div>
          )}
        </div>

        <p className="v-firstrun__note">
          {enable
            ? "We'll download the local runtime and your model the first time you use Refine. You can change any of this later in Settings → Refine."
            : "You can turn Refine on any time in Settings → Refine."}
        </p>
      </div>
    </Modal>
  );
}
