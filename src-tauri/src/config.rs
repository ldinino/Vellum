//! app.json and notebooks.json — app-level config and the notebook registry.
//! Both are written atomically (temp file + rename) so a crash mid-write can
//! never leave a corrupt file behind.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::paths;

// ---------------------------------------------------------------------------
// app.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub settings: AppSettings,
    pub page_templates: Vec<PageTemplate>,
    pub refine_templates: Vec<RefineTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Refine is OFF by default on first run (spec Section 9).
    pub refine_enabled: bool,
    pub grammar_enabled: bool,
    pub spellcheck_enabled: bool,
    pub default_font: String,
    pub default_font_size: u32,
    /// Strict (0.0) .. Liberal (1.0) global default.
    pub refine_adherence: f32,
    /// Fast | Balanced | Thorough; None until first-run detection picks one.
    pub refine_model_tier: Option<String>,
    pub grammar_language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            refine_enabled: false,
            grammar_enabled: false,
            spellcheck_enabled: true,
            default_font: "Segoe UI".into(),
            default_font_size: 11,
            refine_adherence: 0.5,
            refine_model_tier: None,
            grammar_language: "en-US".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageTemplate {
    pub id: String,
    pub name: String,
    /// Tiptap document JSON.
    pub content_json: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RefineTemplate {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub description: Option<String>,
    /// Overrides the global Strict..Liberal setting when set.
    pub adherence_override: Option<f32>,
}

// ---------------------------------------------------------------------------
// notebooks.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookRegistry {
    pub notebooks: Vec<NotebookMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookMeta {
    pub id: String,
    pub name: String,
    /// Folder name under Documents\Vellum (sanitized, may differ from name).
    pub folder: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Atomic JSON I/O
// ---------------------------------------------------------------------------

/// Write JSON atomically: serialize to `<path>.tmp` in the same directory,
/// fsync, then rename over the destination (MoveFileEx with REPLACE_EXISTING
/// on Windows — atomic on NTFS).
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("serialize {}: {e}", path.display()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

fn read_json_or_default<T: Default + for<'de> Deserialize<'de> + Serialize>(
    path: &Path,
) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = T::default();
            write_json_atomic(path, &value)?;
            Ok(value)
        }
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub fn load_app_config(app: &AppHandle) -> Result<AppConfig, String> {
    read_json_or_default(&paths::app_json_path(app)?)
}

pub fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    write_json_atomic(&paths::app_json_path(app)?, config)
}

pub fn load_registry(app: &AppHandle) -> Result<NotebookRegistry, String> {
    read_json_or_default(&paths::notebooks_json_path(app)?)
}

pub fn save_registry(app: &AppHandle, registry: &NotebookRegistry) -> Result<(), String> {
    write_json_atomic(&paths::notebooks_json_path(app)?, registry)
}
