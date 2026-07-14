//! Filesystem layout.
//!
//! User data (default, OneDrive-synced): %USERPROFILE%\Documents\Vellum\
//!   (relocatable via Settings → General; the chosen path is stored in
//!    %LOCALAPPDATA%\Vellum\data-location.txt)
//! Runtime components (never synced):     %LOCALAPPDATA%\Vellum\runtime\[component]\[version]\

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Root of all user data. Defaults to `Documents\Vellum` (OneDrive-synced), but
/// the user can relocate it (Settings → General) to a folder of their choice —
/// e.g. a local, non-synced folder to avoid OneDrive making sync-conflict copies
/// of the live SQLite databases and search index. The custom location is read
/// from a machine-local pointer file (see `data_location_pointer`).
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = custom_data_dir(app) {
        return Ok(custom);
    }
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("cannot resolve Documents directory: {e}"))?;
    Ok(docs.join("Vellum"))
}

/// Machine-local pointer file recording a custom data-root path chosen by the
/// user. It lives beside the runtime/logs under `%LOCALAPPDATA%\Vellum`, never
/// inside the (movable, possibly OneDrive-synced) data root itself — so it is
/// always resolvable regardless of where the data currently lives, and the
/// choice is per-machine (the right scope, since a good local path differs
/// between machines).
fn data_location_pointer(app: &AppHandle) -> Result<PathBuf, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("cannot resolve local data directory: {e}"))?;
    Ok(local.join("Vellum").join("data-location.txt"))
}

/// The user's custom data root if one has been set and is non-empty, else None
/// (fall back to the default `Documents\Vellum`).
fn custom_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let pointer = data_location_pointer(app).ok()?;
    let text = std::fs::read_to_string(&pointer).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Persist a custom data root (an empty path clears it, reverting to the default
/// `Documents\Vellum`). Called after the data has been moved to `root`.
pub fn set_data_root(app: &AppHandle, root: &Path) -> Result<(), String> {
    let pointer = data_location_pointer(app)?;
    if let Some(parent) = pointer.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&pointer, root.to_string_lossy().as_bytes())
        .map_err(|e| format!("write {}: {e}", pointer.display()))
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
pub fn log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("cannot resolve local data directory: {e}"))?;
    Ok(local.join("Vellum").join("logs").join("vellum.log"))
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
