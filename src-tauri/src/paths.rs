//! Filesystem layout.
//!
//! User data (synced by OneDrive):   %USERPROFILE%\Documents\Vellum\
//! Runtime components (never synced): %LOCALAPPDATA%\Vellum\runtime\[component]\[version]\

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Root of all user data: `Documents\Vellum`.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("cannot resolve Documents directory: {e}"))?;
    Ok(docs.join("Vellum"))
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

/// Directory holding one notebook's `notebook.db` and `attachments\`.
pub fn notebook_dir(app: &AppHandle, folder_name: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(folder_name))
}

/// Create `Documents\Vellum` if missing. Called once at startup.
pub fn ensure_data_layout(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
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
