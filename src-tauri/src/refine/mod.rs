//! Refine infrastructure (spec Sections 8, 9; Phase 7).
//!
//! Everything beneath the Refine feature except the Ollama process lifecycle
//! itself (that stays in `process::ollama`): the bundled model manifest,
//! hardware detection + tier mapping, the runtime download/verify/install, model
//! pulling, and the debug-panel inference path.

pub mod hardware;
pub mod manifest;

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
