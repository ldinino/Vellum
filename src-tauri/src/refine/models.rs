//! Model pulling via Ollama's own HTTP API (`POST /api/pull`, streaming NDJSON).
//! Ollama verifies its own blob digests, so we don't SHA-check models — we just
//! ensure the daemon is running, stream the pull, and re-emit progress as
//! `refine://model-progress`.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::ensure_ollama_running;
use super::events;
use super::ndjson::take_lines;
use crate::process::ollama::OLLAMA_PORT;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub model: String,
    pub status: String,
    pub digest: Option<String>,
    pub completed_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub done: bool,
}

#[derive(Debug, Deserialize)]
struct PullLine {
    status: Option<String>,
    digest: Option<String>,
    total: Option<u64>,
    completed: Option<u64>,
    error: Option<String>,
}

/// Ensure Ollama is running, then pull `model`, streaming progress. Surfaces the
/// "runtime not installed" sentinel verbatim so the UI can route to the download.
pub async fn pull_model(app: AppHandle, model: String) -> Result<(), String> {
    ensure_ollama_running(&app).await?;

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{OLLAMA_PORT}/api/pull");
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "name": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Ollama is not responding: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Model pull failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut saw_success = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Ollama stream error: {e}"))?;
        buf.extend_from_slice(&chunk);
        for line in take_lines(&mut buf) {
            if let Some(pl) = parse_line(&line)? {
                if let Some(err) = pl.error {
                    return Err(err); // e.g. "model not found"
                }
                let status = pl.status.clone().unwrap_or_default();
                if status == "success" {
                    saw_success = true;
                }
                let _ = app.emit(
                    events::MODEL_PROGRESS,
                    ModelProgress {
                        model: model.clone(),
                        status,
                        digest: pl.digest,
                        completed_bytes: pl.completed,
                        total_bytes: pl.total,
                        done: false,
                    },
                );
            }
        }
    }
    // A clean pull ends with {"status":"success"}; anything else means the
    // stream was cut short (any trailing partial in `buf` is an incomplete tail).
    if !saw_success {
        return Err("Model download did not complete".into());
    }

    let _ = app.emit(
        events::MODEL_PROGRESS,
        ModelProgress {
            model,
            status: "success".into(),
            digest: None,
            completed_bytes: None,
            total_bytes: None,
            done: true,
        },
    );
    Ok(())
}

/// List models already pulled into the local store (Ollama `/api/tags`).
pub async fn list_models(app: AppHandle) -> Result<Vec<InstalledModel>, String> {
    ensure_ollama_running(&app).await?;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{OLLAMA_PORT}/api/tags");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ollama is not responding: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Listing models failed: HTTP {}", resp.status()));
    }
    let tags: TagsResponse = resp.json().await.map_err(|e| format!("parse tags: {e}"))?;
    let mut models: Vec<InstalledModel> = tags
        .models
        .into_iter()
        .map(|m| InstalledModel {
            name: m.name,
            size_bytes: m.size,
        })
        .collect();
    models.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(models)
}

/// Delete a pulled model and reclaim its disk (Ollama `/api/delete`).
pub async fn delete_model(app: AppHandle, model: String) -> Result<(), String> {
    ensure_ollama_running(&app).await?;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{OLLAMA_PORT}/api/delete");
    let resp = client
        .delete(&url)
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
        .map_err(|e| format!("Ollama is not responding: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Deleting {model} failed: HTTP {}", resp.status()));
    }
    Ok(())
}

fn parse_line(line: &[u8]) -> Result<Option<PullLine>, String> {
    if line.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    serde_json::from_slice(line)
        .map(Some)
        .map_err(|e| format!("unexpected pull status: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_reads_progress_and_errors() {
        let p = parse_line(b"{\"status\":\"pulling manifest\",\"total\":100,\"completed\":40}")
            .unwrap()
            .unwrap();
        assert_eq!(p.status.as_deref(), Some("pulling manifest"));
        assert_eq!(p.total, Some(100));
        assert_eq!(p.completed, Some(40));

        let e = parse_line(b"{\"error\":\"model 'nope' not found\"}")
            .unwrap()
            .unwrap();
        assert_eq!(e.error.as_deref(), Some("model 'nope' not found"));

        let s = parse_line(b"{\"status\":\"success\"}").unwrap().unwrap();
        assert_eq!(s.status.as_deref(), Some("success"));
    }
}
