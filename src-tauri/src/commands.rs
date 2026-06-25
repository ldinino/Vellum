//! Tauri commands exposed to the renderer.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

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

/// Re-mirror a set of a notebook's pages into the master index. Used after a
/// rename, where a denormalized breadcrumb (`section_name` / `notebook_name`)
/// changed but the page content didn't. Best effort: failures are logged.
async fn reindex_pages(app: &AppHandle, notebook_id: &str, page_ids: &[String]) {
    if page_ids.is_empty() {
        return;
    }
    for pid in page_ids {
        index_page(app, notebook_id, pid).await;
    }
}

/// Reindex every page in a section (its `section_name` is denormalized into the
/// master search rows, so a section rename must refresh them).
async fn reindex_section(app: &AppHandle, notebook_id: &str, section_id: &str) {
    let ids = match pool_for(app, notebook_id).await {
        Ok(pool) => {
            let r = notebook::section_page_ids(&pool, section_id).await;
            pool.close().await;
            r
        }
        Err(e) => Err(e),
    };
    match ids {
        Ok(ids) => reindex_pages(app, notebook_id, &ids).await,
        Err(e) => eprintln!("reindex_section {section_id}: {e}"),
    }
}

/// Reindex every page in a notebook (its `notebook_name` is denormalized into the
/// master search rows, so a notebook rename must refresh them).
async fn reindex_notebook(app: &AppHandle, notebook_id: &str) {
    let ids = match pool_for(app, notebook_id).await {
        Ok(pool) => {
            let r = notebook::all_page_ids(&pool).await;
            pool.close().await;
            r
        }
        Err(e) => Err(e),
    };
    match ids {
        Ok(ids) => reindex_pages(app, notebook_id, &ids).await,
        Err(e) => eprintln!("reindex_notebook {notebook_id}: {e}"),
    }
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
    // Bring the schema up to date before any read/write. The startup restore
    // path (list_sections / list_pages) reads notebooks directly, bypassing
    // open_notebook, so without this a newly-shipped migration would never apply
    // (e.g. the page_sort_mode column → "no such column" on list_sections).
    // create_or_migrate is idempotent and cheap when already current.
    db::create_or_migrate(&path).await?;
    db::open_pool(&path, false).await
}

/// Resolve a notebook id to its on-disk folder under `Documents\Vellum`.
fn notebook_folder(app: &AppHandle, notebook_id: &str) -> Result<std::path::PathBuf, String> {
    let registry = config::load_registry(app)?;
    let meta = registry
        .notebooks
        .iter()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    paths::notebook_dir(app, &meta.folder)
}

/// Reduce a dropped file's name to a safe base filename (no path, no Windows-
/// invalid chars), preserving a readable name + extension for display/disk.
fn sanitize_attachment_name(name: &str) -> String {
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !INVALID.contains(c) && !c.is_control())
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned.chars().take(150).collect()
    }
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
    // Hide notebooks that are in the Recycle Bin (spec Section 5.1).
    notebooks.retain(|n| n.deleted_at.is_none());
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

    let mut registry = config::load_registry(&app)?;

    // The folder is the notebook's id (a UUID), not its display name: display
    // names can repeat freely, and a rename never has to move a OneDrive-synced
    // database. UUIDs don't collide, so there's no "already exists" rejection.
    let id = uuid::Uuid::new_v4().to_string();
    let dir = paths::notebook_dir(&app, &id)?;
    std::fs::create_dir_all(dir.join("attachments"))
        .map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Past this point the folder exists; on any failure roll it back so a failed
    // create can't leave an orphaned directory behind.
    if let Err(e) = db::create_or_migrate(&dir.join("notebook.db")).await {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    let meta = NotebookMeta {
        id: id.clone(),
        name: trimmed.to_string(),
        folder: id,
        color: None,
        sort_order: registry
            .notebooks
            .iter()
            .map(|n| n.sort_order)
            .max()
            .map_or(0, |m| m + 1),
        created_at: chrono::Utc::now().to_rfc3339(),
        deleted_at: None,
    };
    registry.notebooks.push(meta.clone());
    if let Err(e) = config::save_registry(&app, &registry) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
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
pub async fn rename_notebook(app: AppHandle, notebook_id: String, name: String) -> Result<NotebookMeta, String> {
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
    // The notebook name is denormalized into every page's search breadcrumb.
    reindex_notebook(&app, &notebook_id).await;
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

/// Soft-delete a notebook into the Recycle Bin (spec Section 5.1): stamp its
/// registry entry's `deleted_at` so it drops out of the notebook list, and clear
/// its rows from the master index. The folder (notebook.db + attachments) stays
/// on disk until the notebook is purged, so it stays fully recoverable.
#[tauri::command]
pub async fn soft_delete_notebook(app: AppHandle, notebook_id: String) -> Result<(), String> {
    let mut registry = config::load_registry(&app)?;
    let meta = registry
        .notebooks
        .iter_mut()
        .find(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    meta.deleted_at = Some(chrono::Utc::now().to_rfc3339());
    config::save_registry(&app, &registry)?;

    let master = search::open_master(&master_index_path(&app)?, true).await?;
    let r = search::remove_notebook(&master, &notebook_id).await;
    master.close().await;
    r
}

/// Permanently delete a notebook: remove its registry entry, its entire folder
/// (notebook.db + attachments), and its master-index rows. Backs the Recycle
/// Bin's purge / empty actions — destructive and irreversible.
async fn purge_notebook(app: &AppHandle, notebook_id: &str) -> Result<(), String> {
    let mut registry = config::load_registry(app)?;
    let idx = registry
        .notebooks
        .iter()
        .position(|n| n.id == notebook_id)
        .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
    let meta = registry.notebooks.remove(idx);

    // Update the registry first so a failed directory delete can't leave a
    // dangling entry pointing at a half-removed folder.
    config::save_registry(app, &registry)?;

    let dir = paths::notebook_dir(app, &meta.folder)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }

    // The notebook.db (and its fts_index) went with the folder; clear the
    // notebook's rows from the master index too.
    let master = search::open_master(&master_index_path(app)?, true).await?;
    let r = search::remove_notebook(&master, notebook_id).await;
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
    r?;
    // The section name is denormalized into search breadcrumbs — refresh them.
    reindex_section(&app, &notebook_id, &section_id).await;
    Ok(())
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
    r?;
    // A rename via Properties changes the denormalized search breadcrumb.
    reindex_section(&app, &notebook_id, &section_id).await;
    Ok(())
}

/// Soft-delete a section into the Recycle Bin (spec Section 5.1): its pages are
/// hidden with it and drop out of search; everything stays in the DB until the
/// section is purged.
#[tauri::command]
pub async fn soft_delete_section(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::soft_delete_section(&pool, &section_id).await;
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

/// Permanently delete a section (cascade) and remove its pages' attachment files.
async fn purge_section(
    app: &AppHandle,
    notebook_id: &str,
    section_id: &str,
) -> Result<(), String> {
    let pool = pool_for(app, notebook_id).await?;
    let r = notebook::delete_section(&pool, section_id).await;
    pool.close().await;
    let page_ids = r?;
    let master = search::open_master(&master_index_path(app)?, true).await?;
    for pid in &page_ids {
        if let Err(e) = search::remove_page(&master, pid).await {
            eprintln!("search index remove failed for page {pid}: {e}");
        }
    }
    master.close().await;
    // The attachment rows cascaded with the section; their files don't — remove
    // each page's attachment folder (fixes a pre-Recycle-Bin disk leak).
    if let Ok(dir) = notebook_folder(app, notebook_id) {
        for pid in &page_ids {
            let att = dir.join("attachments").join(pid);
            if att.is_dir() {
                if let Err(e) = std::fs::remove_dir_all(&att) {
                    eprintln!("purge_section: remove attachments {}: {e}", att.display());
                }
            }
        }
    }
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

#[tauri::command]
pub async fn set_section_sort(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
    mode: String,
    dir: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::set_section_sort(&pool, &section_id, &mode, &dir).await;
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

/// Page-template content (serialized doc JSON + a preview) for a template id, or
/// None if it's missing or not a usable document (spec Section 7).
fn template_content(app: &AppHandle, template_id: &str) -> Option<(String, String)> {
    let cfg = config::load_app_config(app).ok()?;
    let tmpl = cfg.page_templates.iter().find(|t| t.id == template_id)?;
    if !tmpl.content_json.is_object() {
        return None;
    }
    let json = serde_json::to_string(&tmpl.content_json).ok()?;
    let preview: String = crate::search::flatten_text(&json).chars().take(120).collect();
    Some((json, preview))
}

#[tauri::command]
pub async fn create_page(
    app: AppHandle,
    notebook_id: String,
    section_id: String,
    title: String,
) -> Result<Page, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let page = match notebook::create_page(&pool, &section_id, &title).await {
        Ok(p) => p,
        Err(e) => {
            pool.close().await;
            return Err(e);
        }
    };

    // If the section has a page template, seed the new page with its content.
    // The template itself is never modified (we copy its JSON).
    let template = notebook::section_template_id(&pool, &section_id)
        .await
        .ok()
        .flatten()
        .and_then(|tid| template_content(&app, &tid));
    let applied = if let Some((json, preview)) = template {
        notebook::save_page_snapshot(&pool, &page.id, &json, &preview)
            .await
            .is_ok()
    } else {
        false
    };
    pool.close().await;

    if applied {
        index_page(&app, &notebook_id, &page.id).await;
    }
    Ok(page)
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

/// Soft-delete a page into the Recycle Bin (spec Section 5.1): hidden from its
/// section and dropped from search; its content + attachments stay until purge.
#[tauri::command]
pub async fn soft_delete_page(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::soft_delete_page(&pool, &page_id).await;
    pool.close().await;
    r?;
    unindex_page(&app, &page_id).await;
    Ok(())
}

/// Permanently delete a page (cascade) and remove its attachment folder.
async fn purge_page(app: &AppHandle, notebook_id: &str, page_id: &str) -> Result<(), String> {
    let pool = pool_for(app, notebook_id).await?;
    let r = notebook::delete_page(&pool, page_id).await;
    pool.close().await;
    r?;
    unindex_page(app, page_id).await;
    // Remove the page's attachment files (the DB rows cascade, the files don't).
    if let Ok(dir) = notebook_folder(app, notebook_id) {
        let att = dir.join("attachments").join(page_id);
        if att.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&att) {
                eprintln!("purge_page: remove attachments {}: {e}", att.display());
            }
        }
    }
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
// Attachments (spec Section 12)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_attachments(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
) -> Result<Vec<notebook::Attachment>, String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::list_attachments(&pool, &page_id).await;
    pool.close().await;
    r
}

/// Copy a dropped file into `attachments/<page-id>/<uuid>/<name>`, record it, and
/// reindex the page so its filename + MIME type become searchable.
#[tauri::command]
pub async fn add_attachment(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    filename: String,
    bytes: Vec<u8>,
    mime_type: Option<String>,
) -> Result<notebook::Attachment, String> {
    let dir = notebook_folder(&app, &notebook_id)?;
    let safe = sanitize_attachment_name(&filename);
    // Per-attachment uuid folder keeps the original filename intact + collision-free.
    let rel = format!("attachments/{page_id}/{}/{safe}", uuid::Uuid::new_v4());
    let abs = dir.join(&rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&abs, &bytes).map_err(|e| format!("write {}: {e}", abs.display()))?;
    let size = bytes.len() as i64;

    let mime = mime_type.filter(|m| !m.is_empty());
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::add_attachment(&pool, &page_id, &safe, &rel, mime.as_deref(), size).await;
    pool.close().await;
    let att = r?;

    index_page(&app, &notebook_id, &page_id).await;
    Ok(att)
}

/// Remove an attachment from its page into the Recycle Bin (spec Section 5.1).
/// The file is kept on disk (recoverable) until the attachment is purged; the
/// page is reindexed so the filename drops from search immediately.
#[tauri::command]
pub async fn soft_delete_attachment(
    app: AppHandle,
    notebook_id: String,
    attachment_id: String,
) -> Result<(), String> {
    let pool = pool_for(&app, &notebook_id).await?;
    let r = notebook::soft_delete_attachment(&pool, &attachment_id).await;
    pool.close().await;
    if let Some(page_id) = r? {
        index_page(&app, &notebook_id, &page_id).await;
    }
    Ok(())
}

/// Permanently delete one attachment: remove its row, file, and (now-empty)
/// folder, then reindex the page.
async fn purge_attachment(
    app: &AppHandle,
    notebook_id: &str,
    attachment_id: &str,
) -> Result<(), String> {
    let pool = pool_for(app, notebook_id).await?;
    let r = notebook::remove_attachment(&pool, attachment_id).await;
    pool.close().await;

    if let Some((page_id, rel)) = r? {
        let abs = notebook_folder(app, notebook_id)?.join(&rel);
        let _ = std::fs::remove_file(&abs);
        // The file lived in its own uuid folder; clean it up if now empty.
        if let Some(parent) = abs.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        index_page(app, notebook_id, &page_id).await;
    }
    Ok(())
}

/// Open an attachment with the system default application.
#[tauri::command]
pub fn open_attachment(app: AppHandle, notebook_id: String, path: String) -> Result<(), String> {
    // The path comes from our own DB, but reject traversal defensively.
    if path.split(['/', '\\']).any(|c| c == "..") {
        return Err("Invalid attachment path".into());
    }
    let abs = notebook_folder(&app, &notebook_id)?.join(&path);
    if !abs.is_file() {
        return Err(format!("Attachment missing: {}", abs.display()));
    }
    app.opener()
        .open_path(abs.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open attachment: {e}"))
}

// ---------------------------------------------------------------------------
// Recycle Bin (spec Section 5.1)
// ---------------------------------------------------------------------------

/// One entry in the global Recycle Bin: a soft-deleted notebook, section, page,
/// or attachment, with enough context to show and restore it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleItem {
    /// "notebook" | "section" | "page" | "attachment".
    pub kind: String,
    pub id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    /// Display name: notebook/section name, page title, or attachment filename.
    pub name: String,
    /// Breadcrumb of where it lived (notebook, section, or "section / page").
    pub parent: Option<String>,
    /// Byte size (attachments only).
    pub size: Option<i64>,
    pub deleted_at: String,
}

/// Every item currently in the Recycle Bin, across all notebooks, newest first.
/// Soft-deleted notebooks are listed as single entries; live notebooks are
/// scanned for binned sections/pages/attachments whose ancestors are still live.
#[tauri::command]
pub async fn list_recycle_bin(app: AppHandle) -> Result<Vec<RecycleItem>, String> {
    let registry = config::load_registry(&app)?;
    let mut items: Vec<RecycleItem> = Vec::new();

    for nb in registry.notebooks.iter().filter(|n| n.deleted_at.is_some()) {
        items.push(RecycleItem {
            kind: "notebook".into(),
            id: nb.id.clone(),
            notebook_id: nb.id.clone(),
            notebook_name: nb.name.clone(),
            name: nb.name.clone(),
            parent: None,
            size: None,
            deleted_at: nb.deleted_at.clone().unwrap_or_default(),
        });
    }

    for nb in registry.notebooks.iter().filter(|n| n.deleted_at.is_none()) {
        let pool = match pool_for(&app, &nb.id).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("recycle bin: open {}: {e}", nb.id);
                continue;
            }
        };
        let sections = notebook::deleted_sections(&pool).await;
        let pages = notebook::deleted_pages(&pool).await;
        let attachments = notebook::deleted_attachments(&pool).await;
        pool.close().await;

        for s in sections.unwrap_or_default() {
            items.push(RecycleItem {
                kind: "section".into(),
                id: s.id,
                notebook_id: nb.id.clone(),
                notebook_name: nb.name.clone(),
                name: s.name,
                parent: Some(nb.name.clone()),
                size: None,
                deleted_at: s.deleted_at,
            });
        }
        for p in pages.unwrap_or_default() {
            items.push(RecycleItem {
                kind: "page".into(),
                id: p.id,
                notebook_id: nb.id.clone(),
                notebook_name: nb.name.clone(),
                name: if p.title.is_empty() { "Untitled page".into() } else { p.title },
                parent: Some(p.section_name),
                size: None,
                deleted_at: p.deleted_at,
            });
        }
        for a in attachments.unwrap_or_default() {
            let page = if a.page_title.is_empty() {
                "Untitled page".to_string()
            } else {
                a.page_title
            };
            items.push(RecycleItem {
                kind: "attachment".into(),
                id: a.id,
                notebook_id: nb.id.clone(),
                notebook_name: nb.name.clone(),
                name: a.filename,
                parent: Some(format!("{} / {}", a.section_name, page)),
                size: Some(a.size),
                deleted_at: a.deleted_at,
            });
        }
    }

    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

/// Count of items in the Recycle Bin, for the nav footer's empty/full icon.
/// Mirrors `list_recycle_bin`'s ancestor rules via the same queries.
#[tauri::command]
pub async fn count_recycle_bin(app: AppHandle) -> Result<i64, String> {
    let registry = config::load_registry(&app)?;
    let mut count: i64 = registry
        .notebooks
        .iter()
        .filter(|n| n.deleted_at.is_some())
        .count() as i64;
    for nb in registry.notebooks.iter().filter(|n| n.deleted_at.is_none()) {
        let pool = match pool_for(&app, &nb.id).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let s = notebook::deleted_sections(&pool).await.map(|v| v.len()).unwrap_or(0);
        let p = notebook::deleted_pages(&pool).await.map(|v| v.len()).unwrap_or(0);
        let a = notebook::deleted_attachments(&pool).await.map(|v| v.len()).unwrap_or(0);
        pool.close().await;
        count += (s + p + a) as i64;
    }
    Ok(count)
}

/// Restore one Recycle Bin item to where it came from. Re-indexes the affected
/// page(s) so restored content is searchable again.
#[tauri::command]
pub async fn restore_item(
    app: AppHandle,
    kind: String,
    notebook_id: String,
    id: String,
) -> Result<(), String> {
    match kind.as_str() {
        "notebook" => {
            let mut registry = config::load_registry(&app)?;
            let meta = registry
                .notebooks
                .iter_mut()
                .find(|n| n.id == notebook_id)
                .ok_or_else(|| format!("Unknown notebook id {notebook_id}"))?;
            meta.deleted_at = None;
            config::save_registry(&app, &registry)?;
            // Re-mirror the notebook's live pages into the master index.
            reindex_notebook(&app, &notebook_id).await;
            Ok(())
        }
        "section" => {
            let pool = pool_for(&app, &notebook_id).await?;
            let r = notebook::restore_section(&pool, &id).await;
            pool.close().await;
            let page_ids = r?;
            reindex_pages(&app, &notebook_id, &page_ids).await;
            Ok(())
        }
        "page" => {
            let pool = pool_for(&app, &notebook_id).await?;
            let r = notebook::restore_page(&pool, &id).await;
            pool.close().await;
            r?;
            index_page(&app, &notebook_id, &id).await;
            Ok(())
        }
        "attachment" => {
            let pool = pool_for(&app, &notebook_id).await?;
            let r = notebook::restore_attachment(&pool, &id).await;
            pool.close().await;
            if let Some(page_id) = r? {
                index_page(&app, &notebook_id, &page_id).await;
            }
            Ok(())
        }
        other => Err(format!("Unknown recycle item kind: {other}")),
    }
}

/// Permanently delete one Recycle Bin item (and, for containers, everything
/// inside). Irreversible — the frontend confirms first.
#[tauri::command]
pub async fn purge_item(
    app: AppHandle,
    kind: String,
    notebook_id: String,
    id: String,
) -> Result<(), String> {
    match kind.as_str() {
        "notebook" => purge_notebook(&app, &notebook_id).await,
        "section" => purge_section(&app, &notebook_id, &id).await,
        "page" => purge_page(&app, &notebook_id, &id).await,
        "attachment" => purge_attachment(&app, &notebook_id, &id).await,
        other => Err(format!("Unknown recycle item kind: {other}")),
    }
}

/// Permanently delete everything in the Recycle Bin (spec Section 5.1).
/// Irreversible — the frontend confirms first. Best effort: a failure on one
/// item is logged and the rest still run.
#[tauri::command]
pub async fn empty_recycle_bin(app: AppHandle) -> Result<(), String> {
    let registry = config::load_registry(&app)?;

    let deleted_notebooks: Vec<String> = registry
        .notebooks
        .iter()
        .filter(|n| n.deleted_at.is_some())
        .map(|n| n.id.clone())
        .collect();
    for id in &deleted_notebooks {
        if let Err(e) = purge_notebook(&app, id).await {
            eprintln!("empty bin: purge notebook {id}: {e}");
        }
    }

    for nb in registry.notebooks.iter().filter(|n| n.deleted_at.is_none()) {
        let pool = match pool_for(&app, &nb.id).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let sections = notebook::deleted_sections(&pool).await.unwrap_or_default();
        let pages = notebook::deleted_pages(&pool).await.unwrap_or_default();
        let attachments = notebook::deleted_attachments(&pool).await.unwrap_or_default();
        pool.close().await;

        for s in sections {
            if let Err(e) = purge_section(&app, &nb.id, &s.id).await {
                eprintln!("empty bin: purge section {}: {e}", s.id);
            }
        }
        for p in pages {
            if let Err(e) = purge_page(&app, &nb.id, &p.id).await {
                eprintln!("empty bin: purge page {}: {e}", p.id);
            }
        }
        for a in attachments {
            if let Err(e) = purge_attachment(&app, &nb.id, &a.id).await {
                eprintln!("empty bin: purge attachment {}: {e}", a.id);
            }
        }
    }
    Ok(())
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

    let keep: Vec<String> = registry
        .notebooks
        .iter()
        .filter(|n| n.deleted_at.is_none())
        .map(|n| n.id.clone())
        .collect();
    search::prune_notebooks(&master, &keep).await?;

    // Soft-deleted notebooks (Recycle Bin) stay out of search until restored.
    for nb in registry.notebooks.iter().filter(|n| n.deleted_at.is_none()) {
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

/// Replace Harper's custom dictionary with `words` (spec Section 10). The
/// renderer persists the list in `app.json`; this just syncs the in-memory
/// engine so underlines update immediately after add/remove.
#[tauri::command]
pub fn set_dictionary_words(words: Vec<String>) {
    grammar::set_user_words(words);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/// Best-effort `<title>` lookup so a pasted bare URL can show a readable label
/// (e.g. "Google" instead of "https://google.com"). Returns `None` when no
/// usable title is found; the renderer then keeps the raw URL.
#[tauri::command]
pub async fn fetch_link_title(url: String) -> Result<Option<String>, String> {
    crate::link::fetch_title(&url).await
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

// ---------------------------------------------------------------------------
// Refine infrastructure (spec Sections 8, 9) — Phase 7
// ---------------------------------------------------------------------------

/// The bundled model manifest: pinned Ollama runtime + tier→model defaults +
/// hardware thresholds. The renderer reads it to populate the model-tier
/// selector and to know which model a tier pulls.
#[tauri::command]
pub fn refine_get_manifest(app: AppHandle) -> Result<crate::refine::manifest::Manifest, String> {
    crate::refine::manifest::load_manifest(&app)
}

/// Snapshot of Ollama's recent stderr for the debug panel (spec Section 9).
/// Live lines also arrive on the `refine://ollama-log` event.
#[tauri::command]
pub fn refine_ollama_log(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app.state::<crate::refine::logbuf::LogBuffer>().snapshot())
}

/// Whether the pinned Ollama runtime is installed under %LOCALAPPDATA%.
#[tauri::command]
pub fn refine_runtime_status(
    app: AppHandle,
) -> Result<crate::refine::runtime::RuntimeStatus, String> {
    crate::refine::runtime::runtime_status(&app)
}

/// Download + SHA-256 verify + extract the pinned Ollama runtime (idempotent).
/// Emits `refine://runtime-progress`.
#[tauri::command]
pub async fn refine_install_runtime(
    app: AppHandle,
) -> Result<crate::refine::runtime::RuntimeStatus, String> {
    crate::refine::runtime::install_runtime(app).await
}

/// Request cancellation of an in-progress runtime download.
#[tauri::command]
pub fn refine_cancel_install(app: AppHandle) -> Result<(), String> {
    crate::refine::runtime::cancel_install(&app);
    Ok(())
}

/// Pull a model via the running Ollama daemon. Emits `refine://model-progress`.
#[tauri::command]
pub async fn refine_pull_model(app: AppHandle, model: String) -> Result<(), String> {
    crate::refine::models::pull_model(app, model).await
}

/// List models already pulled into the local store.
#[tauri::command]
pub async fn refine_list_models(
    app: AppHandle,
) -> Result<Vec<crate::refine::models::InstalledModel>, String> {
    crate::refine::models::list_models(app).await
}

/// Delete a pulled model and reclaim its disk.
#[tauri::command]
pub async fn refine_delete_model(app: AppHandle, model: String) -> Result<(), String> {
    crate::refine::models::delete_model(app, model).await
}

/// Persist the Refine on/off setting and start/stop Ollama accordingly. When
/// enabling before the runtime is installed, this is a no-op start (the install
/// flow handles fetching it), so toggling on never errors.
#[tauri::command]
pub async fn refine_enable(app: AppHandle, enabled: bool) -> Result<ProcessStatus, String> {
    let mut cfg = config::load_app_config(&app)?;
    cfg.settings.refine_enabled = enabled;
    config::save_app_config(&app, &cfg)?;

    if !enabled {
        return ollama::stop(&app.state::<OllamaState>());
    }

    let app2 = app.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<OllamaState>();
        ollama::start(&app2, &state)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?;
    match started {
        Ok(status) => Ok(status),
        // Not installed yet — leave it for the download flow.
        Err(e) if e == ollama::ERR_RUNTIME_NOT_INSTALLED => Ok(ProcessStatus::default()),
        Err(e) => Err(e),
    }
}

/// Debug panel (spec Section 9): run one /api/generate with arbitrary model and
/// parameters; returns the raw request/response and latency (TTFT + total).
#[tauri::command]
pub async fn refine_debug_generate(
    app: AppHandle,
    req: crate::refine::inference::DebugGenerateRequest,
) -> Result<crate::refine::inference::DebugGenerateResult, String> {
    crate::refine::inference::debug_generate(app, req).await
}

/// Refine (spec Sections 8–9, Phase 8): transform selected text with a template
/// (instructions + examples) at the given adherence. Resolves the tier's model
/// (with memory-aware fallback), strips reasoning, returns the cleaned text for
/// the renderer to diff and render inline.
#[tauri::command]
pub async fn refine_generate(
    app: AppHandle,
    req: crate::refine::run::RefineRequest,
) -> Result<crate::refine::run::RefineResult, String> {
    crate::refine::run::refine_generate(app, req).await
}

/// Release the Ollama process to free memory without disabling Refine (Phase 8
/// keep-warm lifecycle): the renderer calls this after a long idle with no
/// pending suggestions. The next Refine re-spawns Ollama via
/// `ensure_ollama_running`, which still gates on the unchanged `refine_enabled`.
#[tauri::command]
pub fn refine_release(app: AppHandle) -> Result<ProcessStatus, String> {
    ollama::stop(&app.state::<OllamaState>())
}

/// Abort the in-flight Refine generation (Cancel / dismissing the preview): the
/// stream loop drops its connection so Ollama stops generating and frees the CPU.
#[tauri::command]
pub fn refine_cancel() -> Result<(), String> {
    crate::refine::run::request_cancel();
    Ok(())
}

/// Detect RAM + GPUs and recommend a model tier. Runs on a blocking thread:
/// DXGI enumeration uses COM and sysinfo reads the OS.
#[tauri::command]
pub async fn refine_detect_hardware(
    app: AppHandle,
) -> Result<crate::refine::hardware::DetectedHardware, String> {
    tauri::async_runtime::spawn_blocking(move || crate::refine::hardware::detect(&app))
        .await
        .map_err(|e| format!("hardware detect task join error: {e}"))?
}
