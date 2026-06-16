/**
 * Settings → Refine (spec Section 9). Three sub-views:
 *   - Setup: Enable toggle, hardware summary + recommended tier, model-tier
 *     selector, Strict↔Liberal slider, runtime/model download with progress.
 *   - Templates: the Refine template library (RefineTemplatesManager).
 *   - Advanced: the debug panel (RefineDebugPanel).
 *
 * Refine is OFF by default; when off, only the toggle + explanation show — no
 * model or download surfaces (the kill switch, spec Section 9).
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Toggle";
import { Slider } from "../ui/Slider";
import { ProgressBar } from "../ui/ProgressBar";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import { onModelProgress, onRuntimeProgress } from "../../data/events";
import type {
  DetectedHardware,
  Manifest,
  ModelProgress,
  RuntimeProgress,
  RuntimeStatus,
} from "../../data/types";
import { RefineTemplatesManager } from "./RefineTemplatesManager";
import { RefineDebugPanel } from "./RefineDebugPanel";
import "./RefineSettings.css";

const TIERS = ["Fast", "Balanced", "Thorough"] as const;

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`;
  return `${n} B`;
}

type SubView = "setup" | "templates" | "advanced";

export function RefineSettings() {
  const { refineEnabled, refineAdherence, refineModelTier, actions } = useVellum();
  const [view, setView] = useState<SubView>("setup");

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [hardware, setHardware] = useState<DetectedHardware | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);

  const [installProgress, setInstallProgress] = useState<RuntimeProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installingRef = useRef(false);
  installingRef.current = installing;

  useEffect(() => {
    api.refineGetManifest().then(setManifest).catch((e) => setError(String(e)));
    api.refineRuntimeStatus().then(setRuntime).catch(() => {});
    api.refineDetectHardware().then(setHardware).catch(() => {});
  }, []);

  // Tail progress events for the whole panel lifetime.
  useEffect(() => {
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    onRuntimeProgress(setInstallProgress).then((u) => (un1 = u));
    onModelProgress(setModelProgress).then((u) => (un2 = u));
    return () => {
      un1?.();
      un2?.();
    };
  }, []);

  const selectedTier = refineModelTier ?? hardware?.recommendedTier ?? "Fast";
  const tierModel = manifest?.tiers.find((t) => t.id === selectedTier)?.model ?? null;

  const installRuntime = async () => {
    setError(null);
    setInstalling(true);
    setInstallProgress(null);
    try {
      const status = await api.refineInstallRuntime();
      setRuntime(status);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setInstalling(false);
      setInstallProgress(null);
    }
  };

  const pullModel = async () => {
    if (!tierModel) return;
    setError(null);
    setPulling(true);
    setModelProgress(null);
    try {
      await api.refinePullModel(tierModel);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setPulling(false);
      setModelProgress(null);
    }
  };

  return (
    <div className="v-refine">
      <nav className="v-refine__subnav">
        {(["setup", "templates", "advanced"] as SubView[]).map((v) => (
          <button
            key={v}
            type="button"
            className={`v-refine__subtab${v === view ? " is-active" : ""}`}
            onClick={() => setView(v)}
          >
            {v === "setup" ? "Setup" : v === "templates" ? "Templates" : "Advanced"}
          </button>
        ))}
      </nav>

      {view === "templates" && <RefineTemplatesManager />}
      {view === "advanced" && <RefineDebugPanel defaultModel={tierModel ?? undefined} />}

      {view === "setup" && (
        <div className="v-refine__setup">
          <div className="v-refine__row">
            <Toggle
              checked={refineEnabled}
              onChange={(v) => actions.setRefineEnabled(v)}
              label="Enable Refine"
            />
            <span className="v-refine__hint">
              Refine transforms selected text with a local model. Nothing leaves your machine.
            </span>
          </div>

          {!refineEnabled ? (
            <p className="v-refine__off">
              Refine is off. Turn it on to choose a model and download the local runtime.
            </p>
          ) : (
            <>
              {/* Hardware summary + recommended tier */}
              <section className="v-refine__card">
                <h4 className="v-refine__h">This machine</h4>
                {hardware ? (
                  <>
                    <div className="v-refine__hw">
                      {formatBytes(hardware.totalRamBytes)} RAM ·{" "}
                      {hardware.gpuKind === "none"
                        ? "no GPU detected"
                        : hardware.gpus.find((g) => !g.isBasicRenderDriver)?.description ??
                          "GPU"}{" "}
                      ({hardware.gpuKind})
                    </div>
                    <div className="v-refine__rec">
                      Recommended tier: <strong>{hardware.recommendedTier}</strong>
                    </div>
                    {hardware.warning && (
                      <div className="v-refine__warn">⚠ {hardware.warning}</div>
                    )}
                  </>
                ) : (
                  <div className="v-refine__hw">Detecting hardware…</div>
                )}
              </section>

              {/* Model tier */}
              <section className="v-refine__card">
                <h4 className="v-refine__h">Model</h4>
                <div className="v-refine__tiers">
                  {TIERS.map((tier) => {
                    const model = manifest?.tiers.find((t) => t.id === tier)?.model;
                    return (
                      <button
                        key={tier}
                        type="button"
                        className={`v-refine__tier${tier === selectedTier ? " is-active" : ""}`}
                        onClick={() => actions.setRefineModelTier(tier)}
                      >
                        <span className="v-refine__tier-name">{tier}</span>
                        <span className="v-refine__tier-model">{model ?? "—"}</span>
                        {tier === hardware?.recommendedTier && (
                          <span className="v-refine__tier-badge">recommended</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Strict ↔ Liberal */}
              <section className="v-refine__card">
                <h4 className="v-refine__h">Adherence</h4>
                <Slider
                  value={refineAdherence}
                  onChange={(v) => actions.setRefineAdherence(v)}
                  leftLabel="Strict"
                  rightLabel="Liberal"
                />
                <p className="v-refine__sub">
                  Strict follows the template exactly; Liberal reorganizes for clarity.
                </p>
              </section>

              {/* Runtime + model download */}
              <section className="v-refine__card">
                <h4 className="v-refine__h">Local runtime</h4>
                {runtime?.installed ? (
                  <>
                    <div className="v-refine__ok">
                      ✓ Runtime installed ({runtime.version})
                    </div>
                    <div className="v-refine__row">
                      <Button icon="wand" disabled={pulling || !tierModel} onClick={pullModel}>
                        {pulling ? "Downloading model…" : `Download model (${tierModel ?? "—"})`}
                      </Button>
                    </div>
                    {pulling && (
                      <div className="v-refine__progress">
                        <ProgressBar
                          value={
                            modelProgress?.totalBytes
                              ? (modelProgress.completedBytes ?? 0) / modelProgress.totalBytes
                              : null
                          }
                        />
                        <span className="v-refine__progress-label">
                          {modelProgress?.status ?? "starting…"}
                          {modelProgress?.totalBytes
                            ? ` — ${formatBytes(modelProgress.completedBytes ?? 0)} / ${formatBytes(modelProgress.totalBytes)}`
                            : ""}
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="v-refine__sub">
                      The local runtime (~
                      {manifest ? formatBytes(manifest.ollama.sizeBytes) : "1.4 GB"}) downloads
                      once and is stored outside your synced notebooks.
                    </p>
                    <div className="v-refine__row">
                      <Button
                        accent
                        icon="arrow-circle-double"
                        disabled={installing}
                        onClick={installRuntime}
                      >
                        {installing ? "Downloading…" : "Download runtime"}
                      </Button>
                      {installing && (
                        <Button onClick={() => api.refineCancelInstall()}>Cancel</Button>
                      )}
                    </div>
                    {installing && (
                      <div className="v-refine__progress">
                        <ProgressBar
                          value={
                            installProgress?.totalBytes
                              ? installProgress.downloadedBytes / installProgress.totalBytes
                              : null
                          }
                        />
                        <span className="v-refine__progress-label">
                          {installProgress?.phase ?? "starting…"}
                          {installProgress?.phase === "downloading" && installProgress.totalBytes
                            ? ` — ${formatBytes(installProgress.downloadedBytes)} / ${formatBytes(installProgress.totalBytes)}`
                            : ""}
                          {installProgress && installProgress.attempt > 1
                            ? ` (attempt ${installProgress.attempt})`
                            : ""}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </section>

              {error && <div className="v-refine__error">{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
