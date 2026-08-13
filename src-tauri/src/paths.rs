//! Filesystem layout.
//!
//! User data lives in the active **Satchel** (see `satchel.rs`) — by default
//! `%USERPROFILE%\Documents\Vellum`, but the user may keep several and switch
//! between them. Runtime components (never synced) live under
//! `%LOCALAPPDATA%\Vellum\runtime\[component]\[version]\`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::satchel;

/// Root of all user data: the active Satchel's folder.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    satchel::active_dir(app)
}

/// Root for downloaded runtime components: `%LOCALAPPDATA%\Vellum\runtime`.
pub fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("cannot resolve local data directory: {e}"))?;
    Ok(local.join("Vellum").join("runtime"))
}

/// Root for the downloaded Ollama component: `runtime\ollama`. Each pinned
/// version installs into a `<version>\` subdir (newest wins; see
/// `process::ollama::resolve_binary`).
pub fn ollama_component_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join("ollama"))
}

pub fn app_json_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("app.json"))
}

pub fn notebooks_json_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("notebooks.json"))
}

/// Diagnostic log file: `%LOCALAPPDATA%\Vellum\logs\vellum.log` — machine-local,
/// never OneDrive-synced (sits alongside the runtime, not under Documents).
///
/// Routed through `satchel::machine_dir` rather than `local_data_dir` so the
/// debug-only machine-dir override moves it too: two processes sharing one
/// rotating log would make the evidence useless (docs 5.6).
pub fn log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(satchel::machine_dir(app)?.join("logs").join("vellum.log"))
}

/// Directory holding one notebook's `notebook.db` and `attachments\`.
pub fn notebook_dir(app: &AppHandle, folder_name: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(folder_name))
}

/// Dev-only fallback for runtime binaries fetched by scripts/fetch-binaries.ps1.
/// Resolved relative to the source tree at compile time, so it only makes sense
/// in debug builds run from the repo.
#[cfg(debug_assertions)]
pub fn vendor_bin_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("vendor")
        .join("bin");
    dir.is_dir().then_some(dir)
}
