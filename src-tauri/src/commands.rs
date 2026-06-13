//! Tauri commands exposed to the renderer.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use sqlx::{Pool, Sqlite};

use crate::config::{self, AppConfig, NotebookMeta};
use crate::notebook::{self, Page, Section};
use crate::process::ollama::{self, OllamaState};
use crate::process::ProcessStatus;
use crate::{db, paths};

/// Resolve a notebook id to an open pool on its `notebook.db`. Opened per call
/// (SQLite open is cheap); Phase 2's hot auto-save path may add caching.
async fn pool_for(app: &AppHandle, notebook_id: &str) -> Result<Pool<Sqlite>, String> {
    let registry = config::load_registry(app)?;
    let meta = registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    let path = paths::notebook_dir(app, &meta.folder)?.join("notebook.db");
    if !path.is_file() {
        return Err(format!("Notebook database missing: {}", path.display()));
    }
    db::open_pool(&path, false).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data_dir: String,
    pub runtime_dir: String,
}

#[tauri::command]
pub fn get_paths(app: AppHandle) -> Result<AppPaths, String> {
    Ok(AppPaths {
        data_dir: paths::data_dir(&app)?.display().to_string(),
        runtime_dir: paths::runtime_dir(&app)?.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_config(app: AppHandle) -> Result<AppConfig, String> {
    config::load_app_config(&app)
}

#[tauri::command]
pub fn save_app_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    config::save_app_config(&app, &config)
}

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_notebooks(app: AppHandle) -> Result<Vec<NotebookMeta>, String> {
    let mut notebooks = config::load_registry(&app)?.notebooks;
    notebooks.sort_by_key(|n| n.sort_order);
    Ok(notebooks)
}

/// Create a notebook: folder under Documents\Vellum, notebook.db with the
/// current schema, and a registry entry (written atomically).
#[tauri::command]
pub async fn create_notebook(app: AppHandle, name: String) -> Result<NotebookMeta, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Notebook name cannot be empty".into());
    }
    let folder = paths::sanitize_folder_name(trimmed)
        .ok_or_else(|| "Notebook name contains no usable characters".to_string())?;

    let mut registry = config::load_registry(&app)?;
    if registry
        .notebooks
        .iter()
        .any(|n| n.folder.eq_ignore_ascii_case(&folder))
    {
        return Err(format!("A notebook folder named \"{folder}\" already exists"));
    }

    let dir = paths::notebook_dir(&app, &folder)?;
    std::fs::create_dir_all(dir.join("attachments"))
        .map_err(|e| format!("create {}: {e}", dir.display()))?;

    db::create_or_migrate(&dir.join("notebook.db")).await?;

    let meta = NotebookMeta {
        id: uuid::Uuid::new_v4().to_string(),
        name: trimmed.to_string(),
        folder,
        color: None,
        sort_order: registry
            .notebooks
            .iter()
            .map(|n| n.sort_order)
            .max()
            .map_or(0, |m| m + 1),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    registry.notebooks.push(meta.clone());
    config::save_registry(&app, &registry)?;
    Ok(meta)
}

/// Open an existing notebook: integrity check, then migrate if the app
/// shipped a newer schema. Returns the resolved notebook.db path for the
/// frontend to load via tauri-plugin-sql.
#[tauri::command]
pub async fn open_notebook(app: AppHandle, notebook_id: String) -> Result<String, String> {
    let registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    let db_path = paths::notebook_dir(&app, &meta.folder)?.join("notebook.db");
    if !db_path.is_file() {
        return Err(format!("Notebook database missing: {}", db_path.display()));
    }
    if !db::integrity_check(&db_path).await? {
        return Err(format!(
            "Notebook database failed integrity check: {}",
            db_path.display()
        ));
    }
    db::create_or_migrate(&db_path).await?;
    Ok(db_path.display().to_string())
}

/// Rename a notebook (display name only). The folder name stays fixed so we
/// never move a OneDrive-synced database; `name` and `folder` may diverge.
#[tauri::command]
pub fn rename_notebook(app: AppHandle, notebook_id: String, name: String) -> Result<NotebookMeta, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Notebook name cannot be empty".into());
    }
    let mut registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter_mut()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    meta.name = trimmed.to_string();
    let updated = meta.clone();
    config::save_registry(&app, &registry)?;
    Ok(updated)
}

#[tauri::command]
pub fn set_notebook_color(
    app: AppHandle,
    notebook_id: String,
    color: Option<String>,
) -> Result<(), String> {
    let mut registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter_mut()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    meta.color = color;
    config::save_registry(&app, &registry)
}

/// Delete a notebook: remove its registry entry and its entire folder
/// (notebook.db + attachments). Destructive and irreversible — the frontend
/// confirms first.
#[tauri::command]
pub fn delete_notebook(app: AppHandle, notebook_id: String) -> Result<(), String> {
    let mut registry = config::load_registry(&app)?;
    let idx = registry
        .notebooks
        .iter()
        .position(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    let meta = registry.notebooks.remove(idx);

    // Update the registry first so a failed directory delete can't leave a
    // dangling entry pointing at a half-removed folder.
    config::save_registry(&app, &registry)?;

    let dir = paths::notebook_dir(&app, &meta.folder)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Persist a new notebook ordering. `ordered_ids` lists every notebook id in
/// the desired order; sort_order is reassigned to match.
#[tauri::command]
pub fn reorder_notebooks(app: AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let mut registry = config::load_registry(&app)?;
    for (order, id) in ordered_ids.iter().enumerate() {
        if let Some(meta) = registry.notebooks.iter_mut().find(|n| &n.id == id) {
            meta.sort_order = order as i64;
        }
    }
    registry.notebooks.sort_by_key(|n| n.sort_order);
    config::save_registry(&app, &registry)
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sections(app: AppHandle, notebook_id: String) -> Result<Vec<Section>, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::list_sections(&pool).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn create_section(
    app: AppHandle,
    notebook_id: String,
    name: String,
) -> Result<Section, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::create_section(&pool, &name).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn rename_section(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
    name: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::rename_section(&pool, &section_id, &name).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn update_section(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
    name: String,
    color: Option<String>,
    page_template_id: Option<String>,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::update_section(&pool, &section_id, &name, color, page_template_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn delete_section(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::delete_section(&pool, &section_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn reorder_sections(
    app: AppHandle,
    notebook_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::reorder_sections(&pool, &ordered_ids).await;
    pool.close().await;
    r
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_pages(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
) -> Result<Vec<Page>, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::list_pages(&pool, &section_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn create_page(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
    title: String,
) -> Result<Page, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::create_page(&pool, &section_id, &title).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn set_page_title(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    title: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::set_page_title(&pool, &page_id, &title).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn delete_page(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::delete_page(&pool, &page_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn duplicate_page(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
) -> Result<Page, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::duplicate_page(&pool, &page_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn move_page(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    to_section_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::move_page(&pool, &page_id, &to_section_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn reorder_pages(
    app: AppHandle,
    notebook_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::reorder_pages(&pool, &ordered_ids).await;
    pool.close().await;
    r
}

// ---------------------------------------------------------------------------
// Background processes
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ollama_start(app: AppHandle) -> Result<ProcessStatus, String> {
    // start() blocks while polling the port — keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<OllamaState>();
        ollama::start(&app, &state)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub fn ollama_stop(app: AppHandle) -> Result<ProcessStatus, String> {
    ollama::stop(&app.state::<OllamaState>())
}

#[tauri::command]
pub fn ollama_status(app: AppHandle) -> Result<ProcessStatus, String> {
    ollama::status(&app.state::<OllamaState>())
}
