//! Debug-panel inference (spec Section 9, "Debug panel"): one `/api/generate`
//! call with an arbitrary model and full parameter control, returning the exact
//! request sent, the raw response, and latency (time-to-first-token + total).
//! This is for model evaluation and tuning — the real Refine flow is Phase 8.

use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::ensure_ollama_running;
use super::ndjson::take_lines;
use crate::process::ollama::OLLAMA_PORT;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugGenerateRequest {
    pub model: String,
    pub system_prompt: Option<String>,
    pub user_text: String,
    // f64 (not f32) so values from the JS side round-trip cleanly into the
    // request preview — 0.2 stays 0.2, not 0.20000000298.
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub num_predict: Option<i32>,
    pub num_ctx: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugGenerateResult {
    /// The exact JSON body sent to Ollama (pretty-printed).
    pub request_preview: String,
    pub response_text: String,
    pub ttft_ms: u64,
    pub total_ms: u64,
    pub eval_count: Option<u32>,
    pub model: String,
}

#[derive(Debug, Deserialize)]
struct GenLine {
    response: Option<String>,
    eval_count: Option<u32>,
    error: Option<String>,
}

pub async fn debug_generate(
    app: AppHandle,
    req: DebugGenerateRequest,
) -> Result<DebugGenerateResult, String> {
    // Ensure Ollama is running (hard-gates on refine_enabled, blocks on port).
    ensure_ollama_running(&app).await?;

    let body = build_body(&req);
    let request_preview = serde_json::to_string_pretty(&body).unwrap_or_default();

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{OLLAMA_PORT}/api/generate");
    let started = Instant::now();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama is not responding: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Generate failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut response_text = String::new();
    let mut ttft_ms: Option<u64> = None;
    let mut eval_count: Option<u32> = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Ollama stream error: {e}"))?;
        buf.extend_from_slice(&chunk);
        for line in take_lines(&mut buf) {
            let gl: GenLine = match serde_json::from_slice(&line) {
                Ok(g) => g,
                Err(_) => continue, // ignore any non-JSON keep-alive line
            };
            if let Some(err) = gl.error {
                return Err(err);
            }
            if let Some(piece) = gl.response {
                if !piece.is_empty() && ttft_ms.is_none() {
                    ttft_ms = Some(started.elapsed().as_millis() as u64);
                }
                response_text.push_str(&piece);
            }
            if let Some(ec) = gl.eval_count {
                eval_count = Some(ec);
            }
        }
    }
    let total_ms = started.elapsed().as_millis() as u64;

    Ok(DebugGenerateResult {
        request_preview,
        response_text,
        ttft_ms: ttft_ms.unwrap_or(total_ms),
        total_ms,
        eval_count,
        model: req.model,
    })
}

/// Build the `/api/generate` body, omitting any `None` option so Ollama uses its
/// own defaults.
fn build_body(req: &DebugGenerateRequest) -> serde_json::Value {
    use serde_json::{json, Map, Value};

    let mut options = Map::new();
    if let Some(v) = req.temperature {
        options.insert("temperature".into(), json!(v));
    }
    if let Some(v) = req.top_p {
        options.insert("top_p".into(), json!(v));
    }
    if let Some(v) = req.top_k {
        options.insert("top_k".into(), json!(v));
    }
    if let Some(v) = req.num_predict {
        options.insert("num_predict".into(), json!(v));
    }
    if let Some(v) = req.num_ctx {
        options.insert("num_ctx".into(), json!(v));
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("prompt".into(), json!(req.user_text));
    if let Some(sys) = &req.system_prompt {
        if !sys.is_empty() {
            body.insert("system".into(), json!(sys));
        }
    }
    body.insert("stream".into(), json!(true));
    if !options.is_empty() {
        body.insert("options".into(), Value::Object(options));
    }
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> DebugGenerateRequest {
        DebugGenerateRequest {
            model: "qwen2.5:7b".into(),
            system_prompt: Some("Be terse.".into()),
            user_text: "Hello".into(),
            temperature: Some(0.2),
            top_p: None,
            top_k: None,
            num_predict: Some(128),
            num_ctx: None,
        }
    }

    #[test]
    fn body_includes_set_options_and_omits_none() {
        let body = build_body(&req());
        assert_eq!(body["model"], "qwen2.5:7b");
        assert_eq!(body["prompt"], "Hello");
        assert_eq!(body["system"], "Be terse.");
        assert_eq!(body["stream"], true);
        assert_eq!(body["options"]["temperature"], 0.2);
        assert_eq!(body["options"]["num_predict"], 128);
        assert!(body["options"].get("top_p").is_none());
        assert!(body["options"].get("num_ctx").is_none());
    }

    #[test]
    fn empty_system_prompt_is_omitted() {
        let mut r = req();
        r.system_prompt = Some(String::new());
        let body = build_body(&r);
        assert!(body.get("system").is_none());
    }
}
