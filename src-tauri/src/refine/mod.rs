//! Refine infrastructure (spec Sections 8, 9; Phase 7).
//!
//! Everything beneath the Refine feature except the Ollama process lifecycle
//! itself (that stays in `process::ollama`): the bundled model manifest,
//! hardware detection + tier mapping, the runtime download/verify/install, model
//! pulling, and the debug-panel inference path.

pub mod hardware;
pub mod inference;
pub mod logbuf;
pub mod manifest;
pub mod models;
pub mod ndjson;
pub mod runtime;

use tauri::{AppHandle, Manager};

use crate::process::ollama::{self, OllamaState};

/// Ensure Ollama is running (start() hard-gates on refine_enabled and blocks
/// polling the port). Shared by model pull, model management, and debug
/// inference, so they all surface the not-installed sentinel identically.
pub(crate) async fn ensure_ollama_running(app: &AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<OllamaState>();
        ollama::start(&app2, &state).map(|_| ())
    })
    .await
    .map_err(|e| format!("ollama start task join error: {e}"))?
}

/// Tauri event channels. Payloads are serde camelCase; the renderer subscribes
/// via `@tauri-apps/api/event`. Best-effort — a dropped progress event must
/// never fail the operation reporting it.
pub mod events {
    /// Ollama runtime download/verify/extract progress (`RuntimeProgress`).
    pub const RUNTIME_PROGRESS: &str = "refine://runtime-progress";
    /// `ollama pull` progress (`ModelProgress`).
    pub const MODEL_PROGRESS: &str = "refine://model-progress";
    /// A line of Ollama's stderr (`{ "line": String }`).
    pub const OLLAMA_LOG: &str = "refine://ollama-log";
}
