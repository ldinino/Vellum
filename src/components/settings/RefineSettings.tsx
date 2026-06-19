/**
 * Settings → Refine (spec Section 9). Three sub-views:
 *   - Setup: Enable toggle, hardware summary + recommended tier, model-tier
 *     selector with sizes, 3-click adherence, runtime + model downloads with
 *     progress, and installed-model management (delete to reclaim disk).
 *   - Templates: the Refine template library (RefineTemplatesManager).
 *   - Advanced: the debug panel (RefineDebugPanel).
 *
 * Refine is OFF by default; when off, only the toggle + explanation show — no
 * model or download surfaces (the kill switch, spec Section 9).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Toggle } from "../ui/Toggle";
import { AdherenceControl } from "../ui/AdherenceControl";
import { ProgressBar } from "../ui/ProgressBar";
import { useVellum } from "../../state/vellum";
import * as api from "../../data/api";
import { onModelProgress, onRuntimeProgress } from "../../data/events";
import type {
  DetectedHardware,
  InstalledModel,
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
  const [installed, setInstalled] = useState<InstalledModel[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installingRef = useRef(false);
  installingRef.current = installing;

  useEffect(() => {
    api.refineGetManifest().then(setManifest).catch((e) => setError(String(e)));
    api.refineRuntimeStatus().then(setRuntime).catch(() => {});
    api.refineDetectHardware().then(setHardware).catch(() => {});
  }, []);

  // List installed models once the runtime is present and Refine is on. This
  // starts `ollama serve` (lightweight — no model is loaded into RAM just to
  // read the catalog), which is allowed because Refine is enabled here.
  const refreshInstalled = useCallback(() => {
    api.refineListModels().then(setInstalled).catch(() => setInstalled([]));
  }, []);

  useEffect(() => {
    if (refineEnabled && runtime?.installed) refreshInstalled();
  }, [refineEnabled, runtime?.installed, refreshInstalled]);

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

  const pullModel = async (model: string) => {
    setError(null);
    setPulling(true);
    setModelProgress(null);
    try {
      await api.refinePullModel(model);
      refreshInstalled();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setPulling(false);
      setModelProgress(null);
    }
  };

  const deleteModel = async (model: string) => {
    setError(null);
    setDeleting(model);
    try {
      await api.refineDeleteModel(model);
      refreshInstalled();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setDeleting(null);
    }
  };

  const isInstalled = (model: string | null) =>
    !!model && !!installed?.some((m) => m.name === model);

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
                    const t = manifest?.tiers.find((m) => m.id === tier);
                    return (
                      <button
                        key={tier}
                        type="button"
                        className={`v-refine__tier${tier === selectedTier ? " is-active" : ""}`}
                        onClick={() => actions.setRefineModelTier(tier)}
                      >
                        <span className="v-refine__tier-name">
                          {tier}
                          {isInstalled(t?.model ?? null) && (
                            <span className="v-refine__tier-check" title="Installed">
                              ✓
                            </span>
                          )}
                        </span>
                        <span className="v-refine__tier-model">{t?.model ?? "—"}</span>
                        <span className="v-refine__tier-size">
                          {t ? `${t.sizeLabel} · needs ${t.targetRamLabel}` : ""}
                        </span>
                        {t?.useFor && <span className="v-refine__tier-use">{t.useFor}</span>}
                        {tier === hardware?.recommendedTier && (
                          <span className="v-refine__tier-badge">recommended</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {manifest?.tiers.find((t) => t.id === selectedTier)?.fallback && (
                  <p className="v-refine__sub">
                    Lighter option if memory is tight:{" "}
                    {manifest.tiers.find((t) => t.id === selectedTier)!.fallback!.model} (
                    {manifest.tiers.find((t) => t.id === selectedTier)!.fallback!.sizeLabel})
                  </p>
                )}
              </section>

              {/* Strict ↔ Liberal */}
              <section className="v-refine__card">
                <h4 className="v-refine__h">Adherence</h4>
                <AdherenceControl
                  value={refineAdherence}
                  onChange={(v) => actions.setRefineAdherence(v)}
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
                      <Button
                        icon="wand"
                        disabled={pulling || !tierModel}
                        onClick={() => tierModel && pullModel(tierModel)}
                      >
                        {pulling
                          ? "Downloading model…"
                          : isInstalled(tierModel)
                            ? `Re-download ${tierModel}`
                            : `Download ${selectedTier} model (${tierModel ?? "—"}, ${
                                manifest?.tiers.find((t) => t.id === selectedTier)?.sizeLabel ?? "?"
                              })`}
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

                    {/* Installed models — manage / reclaim disk */}
                    <div className="v-refine__installed">
                      <div className="v-refine__installed-head">
                        Installed models
                        <button
                          type="button"
                          className="v-refine__refresh"
                          title="Refresh"
                          onClick={refreshInstalled}
                        >
                          <Icon name="arrow-circle-double" />
                        </button>
                      </div>
                      {installed == null ? (
                        <div className="v-refine__sub">Loading…</div>
                      ) : installed.length === 0 ? (
                        <div className="v-refine__sub">No models downloaded yet.</div>
                      ) : (
                        <ul className="v-refine__models">
                          {installed.map((m) => (
                            <li key={m.name} className="v-refine__model">
                              <span className="v-refine__model-name">{m.name}</span>
                              <span className="v-refine__model-size">
                                {formatBytes(m.sizeBytes)}
                              </span>
                              <button
                                type="button"
                                className="v-refine__model-del"
                                disabled={deleting === m.name}
                                onClick={() => deleteModel(m.name)}
                              >
                                {deleting === m.name ? "Deleting…" : "Delete"}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
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
