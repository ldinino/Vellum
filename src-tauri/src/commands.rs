//! Tauri commands exposed to the renderer.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use sqlx::{Pool, Sqlite};

use crate::config::{self, AppConfig, NotebookMeta};
use crate::notebook::{self, Page, Section};
use crate::process::ollama::{self, OllamaState};
use crate::process::ProcessStatus;
use crate::grammar::{self, GrammarSpan};
use crate::search::{self, SearchFilters, SearchHit};
use crate::{db, paths};

/// Path to the master cross-notebook search index in the Vellum root.
fn master_index_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(paths::data_dir(app)?.join("search-index.db"))
}

/// Display name for a notebook id, used in search breadcrumbs.
fn notebook_name(app: &AppHandle, notebook_id: &str) -> Result<String, String> {
    let registry = config::load_registry(app)?;
    registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .map(|n| n.name.clone())
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))
}

/// Rebuild a page's per-notebook and master index rows. Index upkeep is best
/// effort: failures are logged, not surfaced, so a stale index never blocks the
/// user's edit. (`reindex_all` and the next save will heal it.)
async fn index_page(app: &AppHandle, notebook_id: &str, page_id: &str) {
    if let Err(e) = index_page_inner(app, notebook_id, page_id).await {
        eprintln!("search index update failed for page {page_id}: {e}");
    }
}

async fn index_page_inner(app: &AppHandle, notebook_id: &str, page_id: &str) -> Result<(), String> {
    let pool = pool_for(app, notebook_id).await?;
    let data = notebook::reindex_page(&pool, page_id).await;
    pool.close().await;

    let master = search::open_master(&master_index_path(app)?, true).await?;
    let r = match data? {
        Some(data) => {
            let name = notebook_name(app, notebook_id)?;
            search::upsert_master(&master, notebook_id, &name, &data).await
        }
        None => search::remove_page(&master, page_id).await,
    };
    master.close().await;
    r
}

/// Drop a page's row from the master index (used on delete, where the
/// per-notebook row is already gone with the page).
async fn unindex_page(app: &AppHandle, page_id: &str) {
    if let Err(e) = async {
        let master = search::open_master(&master_index_path(app)?, true).await?;
        let r = search::remove_page(&master, page_id).await;
        master.close().await;
        r
    }
    .await
    {
        eprintln!("search index remove failed for page {page_id}: {e}");
    }
}

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
pub async fn delete_notebook(app: AppHandle, notebook_id: String) -> Result<(), String> {
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

    // The notebook.db (and its fts_index) went with the folder; clear the
    // notebook's rows from the master index too.
    let master = search::open_master(&master_index_path(&app)?, true).await?;
    let r = search::remove_notebook(&master, &notebook_id).await;
    master.close().await;
    r
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
    let page_ids = r?;
    let master = search::open_master(&master_index_path(&app)?, true).await?;
    for pid in &page_ids {
        if let Err(e) = search::remove_page(&master, pid).await {
            eprintln!("search index remove failed for page {pid}: {e}");
        }
    }
    master.close().await;
    Ok(())
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
    r?;
    index_page(&app, &notebook_id, &page_id).await;
    Ok(())
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
    r?;
    unindex_page(&app, &page_id).await;
    Ok(())
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
    let page = r?;
    index_page(&app, &notebook_id, &page.id).await;
    Ok(page)
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
    r?;
    // Section changed → refresh the indexed breadcrumb.
    index_page(&app, &notebook_id, &page_id).await;
    Ok(())
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

/// Absolute path to a notebook's folder (for the renderer to resolve
/// attachment-relative image paths into asset:// URLs).
#[tauri::command]
pub fn notebook_path(app: AppHandle, notebook_id: String) -> Result<String, String> {
    let registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    Ok(paths::notebook_dir(&app, &meta.folder)?.display().to_string())
}

/// Store a pasted/dropped image under `attachments/<page-id>/` and return its
/// notebook-relative path (forward slashes) for embedding in the doc.
#[tauri::command]
pub fn save_page_image(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;

    // Keep only a safe, short extension; default to png.
    let ext: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };

    let rel = format!("attachments/{page_id}/{}.{ext}", uuid::Uuid::new_v4());
    let abs = paths::notebook_dir(&app, &meta.folder)?.join(&rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&abs, &bytes).map_err(|e| format!("write {}: {e}", abs.display()))?;
    Ok(rel)
}

// ---------------------------------------------------------------------------
// Page content & auto-save
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_page_content(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
) -> Result<Option<String>, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::load_page_content(&pool, &page_id).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn append_page_op(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    op_json: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::append_page_op(&pool, &page_id, &op_json).await;
    pool.close().await;
    r
}

#[tauri::command]
pub async fn save_page_snapshot(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    content_json: String,
    preview: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::save_page_snapshot(&pool, &page_id, &content_json, &preview).await;
    pool.close().await;
    r?;
    // Re-index on every durable snapshot (spec Section 11).
    index_page(&app, &notebook_id, &page_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Search (spec Section 11)
// ---------------------------------------------------------------------------

/// Search the master index. `filters.notebookIds` scopes the query (empty/absent
/// = all notebooks); the other filters narrow by section, date range, and
/// attachment presence.
#[tauri::command]
pub async fn search(
    app: AppHandle,
    query: String,
    filters: SearchFilters,
) -> Result<Vec<SearchHit>, String> {
    let master = search::open_master(&master_index_path(&app)?, true).await?;
    let r = search::search(&master, &query, &filters).await;
    master.close().await;
    r
}

/// Rebuild the master index from every notebook. Called on startup (in the
/// background) so global search is complete and self-heals after out-of-band
/// edits; also refreshes each notebook's own `fts_index`.
#[tauri::command]
pub async fn reindex_all(app: AppHandle) -> Result<(), String> {
    let registry = config::load_registry(&app)?;
    let master = search::open_master(&master_index_path(&app)?, true).await?;

    let keep: Vec<String> = registry.notebooks.iter().map(|n| n.id.clone()).collect();
    search::prune_notebooks(&master, &keep).await?;

    for nb in &registry.notebooks {
        // Skip notebooks whose DB is missing rather than failing the whole rebuild.
        let path = match paths::notebook_dir(&app, &nb.folder) {
            Ok(dir) => dir.join("notebook.db"),
            Err(_) => continue,
        };
        if !path.is_file() {
            continue;
        }
        let pool = match db::open_pool(&path, false).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("reindex_all: open {}: {e}", nb.id);
                continue;
            }
        };
        // Drop the notebook's master rows, then re-add every current page so
        // deletions made while closed don't linger.
        if let Err(e) = search::remove_notebook(&master, &nb.id).await {
            eprintln!("reindex_all: clear {}: {e}", nb.id);
        }
        match notebook::all_page_ids(&pool).await {
            Ok(ids) => {
                for pid in ids {
                    match notebook::reindex_page(&pool, &pid).await {
                        Ok(Some(data)) => {
                            if let Err(e) =
                                search::upsert_master(&master, &nb.id, &nb.name, &data).await
                            {
                                eprintln!("reindex_all: upsert {pid}: {e}");
                            }
                        }
                        Ok(None) => {}
                        Err(e) => eprintln!("reindex_all: reindex {pid}: {e}"),
                    }
                }
            }
            Err(e) => eprintln!("reindex_all: page ids {}: {e}", nb.id),
        }
        pool.close().await;
    }

    master.close().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Grammar (spec Section 10) — Harper, in-process
// ---------------------------------------------------------------------------

/// Lint a page's plain text and return spans (UTF-16 offsets, message, kind,
/// suggestions). Runs on a blocking thread: linting is CPU-bound and the first
/// call loads the embedded dictionary + POS model.
#[tauri::command]
pub async fn grammar_check(text: String) -> Result<Vec<GrammarSpan>, String> {
    tauri::async_runtime::spawn_blocking(move || grammar::check(&text))
        .await
        .map_err(|e| format!("grammar task join error: {e}"))
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
