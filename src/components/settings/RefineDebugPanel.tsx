/**
 * Refine debug panel (spec Section 9, "Debug panel"). Not surfaced in normal
 * use — for development, model evaluation, and tuning. Runs one /api/generate
 * with an arbitrary model + full parameter control and shows the exact request,
 * the raw response, latency (time-to-first-token + total), and Ollama's log.
 *
 * This is also the Lunar Lake benchmark hook: pick a tier's model, run a fixed
 * prompt, and read tokens/sec off the latency + eval count.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import * as api from "../../data/api";
import { onOllamaLog } from "../../data/events";
import type { DebugGenerateResult } from "../../data/types";
import "./RefineDebugPanel.css";

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function RefineDebugPanel({ defaultModel }: { defaultModel?: string }) {
  const [model, setModel] = useState(defaultModel ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userText, setUserText] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [topK, setTopK] = useState("");
  const [numPredict, setNumPredict] = useState("");
  const [numCtx, setNumCtx] = useState("");

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DebugGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  // Backfill the log snapshot, then tail live lines.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    api.refineOllamaLog().then(setLog).catch(() => {});
    onOllamaLog((line) => setLog((l) => [...l.slice(-2000), line])).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const run = async () => {
    if (!model.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.refineDebugGenerate({
        model: model.trim(),
        systemPrompt: systemPrompt.trim() || null,
        userText,
        temperature: numOrNull(temperature),
        topP: numOrNull(topP),
        topK: numOrNull(topK),
        numPredict: numOrNull(numPredict),
        numCtx: numOrNull(numCtx),
      });
      setResult(res);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setRunning(false);
    }
  };

  const tokensPerSec =
    result?.evalCount && result.totalMs > result.ttftMs
      ? (result.evalCount / ((result.totalMs - result.ttftMs) / 1000)).toFixed(1)
      : null;

  return (
    <div className="v-dbg">
      <div className="v-dbg__controls">
        <label className="v-dbg__field v-dbg__field--wide">
          <span className="v-dbg__label">Model</span>
          <input
            className="v-dbg__input"
            value={model}
            placeholder="e.g. qwen2.5:7b"
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="v-dbg__field">
          <span className="v-dbg__label">Temperature</span>
          <input className="v-dbg__input" value={temperature} placeholder="default" onChange={(e) => setTemperature(e.target.value)} />
        </label>
        <label className="v-dbg__field">
          <span className="v-dbg__label">top_p</span>
          <input className="v-dbg__input" value={topP} placeholder="default" onChange={(e) => setTopP(e.target.value)} />
        </label>
        <label className="v-dbg__field">
          <span className="v-dbg__label">top_k</span>
          <input className="v-dbg__input" value={topK} placeholder="default" onChange={(e) => setTopK(e.target.value)} />
        </label>
        <label className="v-dbg__field">
          <span className="v-dbg__label">num_predict</span>
          <input className="v-dbg__input" value={numPredict} placeholder="default" onChange={(e) => setNumPredict(e.target.value)} />
        </label>
        <label className="v-dbg__field">
          <span className="v-dbg__label">context size</span>
          <input className="v-dbg__input" value={numCtx} placeholder="default" onChange={(e) => setNumCtx(e.target.value)} />
        </label>
      </div>

      <label className="v-dbg__field">
        <span className="v-dbg__label">System prompt</span>
        <textarea className="v-dbg__area" rows={2} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </label>
      <label className="v-dbg__field">
        <span className="v-dbg__label">User text</span>
        <textarea className="v-dbg__area" rows={3} value={userText} onChange={(e) => setUserText(e.target.value)} />
      </label>

      <div className="v-dbg__run">
        <Button accent icon="wand" disabled={!model.trim() || running} onClick={run}>
          {running ? "Generating…" : "Generate"}
        </Button>
        {result && (
          <span className="v-dbg__metrics">
            TTFT {result.ttftMs} ms · total {result.totalMs} ms
            {result.evalCount != null && ` · ${result.evalCount} tokens`}
            {tokensPerSec && ` · ${tokensPerSec} tok/s`}
          </span>
        )}
      </div>

      {error && <div className="v-dbg__error">{error}</div>}

      <div className="v-dbg__io">
        <div className="v-dbg__col">
          <span className="v-dbg__label">Request</span>
          <pre className="v-dbg__pre">{result?.requestPreview ?? ""}</pre>
        </div>
        <div className="v-dbg__col">
          <span className="v-dbg__label">Response</span>
          <pre className="v-dbg__pre">{result?.responseText ?? ""}</pre>
        </div>
      </div>

      <div className="v-dbg__col v-dbg__col--log">
        <span className="v-dbg__label">Ollama log</span>
        <pre className="v-dbg__pre v-dbg__pre--log" ref={logRef}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
