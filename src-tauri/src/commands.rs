//! Tauri commands exposed to the renderer.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use sqlx::{Pool, Sqlite};

use crate::applog::{AppLog, LogEntry};
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

/// Recursively copy a directory tree (used by `move_dir` when a plain rename
/// can't cross a volume boundary).
fn copy_dir_all(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a directory `src` -> `dest`: a fast rename when both sides share a
/// volume, else copy the whole tree and remove the original (a rename fails
/// across drives on Windows). `dest` must not already exist. On a copy that
/// partially fails, the original is left intact (the caller only records the new
/// location after this returns Ok), so the notebook is never lost.
fn move_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_all(src, dest)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))?;
    std::fs::remove_dir_all(src)
        .map_err(|e| format!("remove original {}: {e}", src.display()))?;
    Ok(())
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
// Export / Print & version info (Phase 10, spec Sections 14 / 15)
// ---------------------------------------------------------------------------

/// One file to copy alongside an exported page: a notebook-relative source (an
/// inline image or an attachment) and the basename it gets in the export's
/// sibling `.attachments/` folder. Dest names are deduped by the renderer.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCopy {
    /// Notebook-relative path (e.g. `attachments/<page>/<uuid>/<file>`).
    src_rel: String,
    /// Destination filename within the export files folder.
    dest_name: String,
}

/// Write a page's Markdown to `md_path` and copy its images + attachments into a
/// sibling `<files_dir_name>/` folder next to it (spec Section 14). The Markdown
/// and the dest filenames are produced by the renderer (HTML → Markdown); this
/// command owns the filesystem writes. Source paths are validated against the
/// notebook dir (no traversal) and dest names are sanitized.
#[tauri::command]
pub fn export_page(
    app: AppHandle,
    notebook_id: String,
    md_path: String,
    markdown: String,
    files_dir_name: String,
    copies: Vec<ExportCopy>,
) -> Result<(), String> {
    let md_path = std::path::PathBuf::from(&md_path);
    let parent = md_path
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;

    if !copies.is_empty() {
        let nb_dir = notebook_folder(&app, &notebook_id)?;
        // The renderer sends a known folder name (the ADO `.attachments` convention).
        // The shared sanitizer strips leading dots (correct for file names), so
        // preserve a single leading dot for the directory name only.
        let sanitized = sanitize_attachment_name(&files_dir_name);
        let dir_name =
            if files_dir_name.trim_start().starts_with('.') && !sanitized.starts_with('.') {
                format!(".{sanitized}")
            } else {
                sanitized
            };
        let files_dir = parent.join(&dir_name);
        std::fs::create_dir_all(&files_dir)
            .map_err(|e| format!("create {}: {e}", files_dir.display()))?;
        for c in &copies {
            // Source comes from our own DB/editor, but reject traversal defensively
            // (matches open_attachment).
            if c.src_rel.split(['/', '\\']).any(|p| p == "..") {
                return Err(format!("Invalid source path: {}", c.src_rel));
            }
            let src = nb_dir.join(&c.src_rel);
            // A referenced file that's missing on disk is skipped rather than
            // aborting the whole export.
            if !src.is_file() {
                continue;
            }
            let dest = files_dir.join(sanitize_attachment_name(&c.dest_name));
            std::fs::copy(&src, &dest).map_err(|e| format!("copy {}: {e}", src.display()))?;
        }
    }

    std::fs::write(&md_path, markdown.as_bytes())
        .map_err(|e| format!("write {}: {e}", md_path.display()))?;
    Ok(())
}

/// One page in a multi-page Markdown export: its path relative to the export
/// root (e.g. `Notebook/Section/Page.md`), the rendered Markdown, and the files
/// it references (copied into the single shared attachments folder).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPageEntry {
    rel_path: String,
    markdown: String,
    copies: Vec<ExportCopy>,
}

/// Write a batch of pages under `dest_dir` (each at `<dest_dir>/<rel_path>`) and
/// copy every referenced file into one shared `<dest_dir>/<attachments_dir_name>/`
/// folder — the Azure DevOps wiki layout (spec Section 14 / execution-plan #6).
/// All sources come from a single notebook. Relative paths are validated against
/// traversal; missing sources are skipped. Returns the number of pages written.
#[tauri::command]
pub fn export_batch(
    app: AppHandle,
    notebook_id: String,
    dest_dir: String,
    attachments_dir_name: String,
    pages: Vec<ExportPageEntry>,
) -> Result<u32, String> {
    let dest_dir = std::path::PathBuf::from(&dest_dir);
    if !dest_dir.is_dir() {
        return Err(format!("Destination is not a folder: {}", dest_dir.display()));
    }
    let nb_dir = notebook_folder(&app, &notebook_id)?;

    // Shared attachments folder, created lazily on the first copy. Preserve a
    // single leading dot (the ADO `.attachments` convention) that the shared
    // filename sanitizer would otherwise strip.
    let sanitized = sanitize_attachment_name(&attachments_dir_name);
    let attach_name =
        if attachments_dir_name.trim_start().starts_with('.') && !sanitized.starts_with('.') {
            format!(".{sanitized}")
        } else {
            sanitized
        };
    let attach_dir = dest_dir.join(&attach_name);
    let mut attach_created = false;

    let mut written = 0u32;
    for page in &pages {
        // The relative path is built from sanitized names, but validate defensively:
        // no absolute paths, no empty or `..` segments (no escaping dest_dir).
        let rel = page.rel_path.replace('\\', "/");
        if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|p| p.is_empty() || p == "..")
        {
            return Err(format!("Invalid export path: {}", page.rel_path));
        }
        let md_path = dest_dir.join(&rel);
        if let Some(parent) = md_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&md_path, page.markdown.as_bytes())
            .map_err(|e| format!("write {}: {e}", md_path.display()))?;
        written += 1;

        for c in &page.copies {
            if c.src_rel.split(['/', '\\']).any(|p| p == "..") {
                return Err(format!("Invalid source path: {}", c.src_rel));
            }
            let src = nb_dir.join(&c.src_rel);
            if !src.is_file() {
                continue;
            }
            if !attach_created {
                std::fs::create_dir_all(&attach_dir)
                    .map_err(|e| format!("create {}: {e}", attach_dir.display()))?;
                attach_created = true;
            }
            let dest = attach_dir.join(sanitize_attachment_name(&c.dest_name));
            std::fs::copy(&src, &dest).map_err(|e| format!("copy {}: {e}", src.display()))?;
        }
    }
    Ok(written)
}

/// Open a folder (the export destination) in the system file manager. Used by the
/// export wizard's "Open folder" button. The path comes from a folder-picker
/// dialog / a `.md` save dialog, so it's user-chosen; validated to exist first.
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    app.opener()
        .open_path(p.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open path: {e}"))
}

// ---------------------------------------------------------------------------
// Import documents into notebooks (execution-plan #4, spec Section 14)
// ---------------------------------------------------------------------------
//
// The mirror of export: the frontend converts each document to editor JSON
// (Markdown / HTML / text / DOCX) and writes pages via the normal create + save
// commands; the backend just owns the filesystem reads a picked source needs
// (its bytes, a folder scan, and copying referenced images into a page). All of
// these read paths that live *outside* Documents\Vellum, so they use plain
// `std::fs` — our own commands need no capability, avoiding a plugin-fs scope.

/// One importable document found while scanning a folder. The frontend groups
/// these into sections (by the top-level subfolder) and reads each via
/// `import_read_file`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    /// Path relative to the scanned root, forward-slash separated (drives the
    /// section grouping and a filename-derived page title).
    rel_path: String,
    /// Absolute path on disk (passed straight back to `import_read_file`).
    abs_path: String,
    /// Lowercase extension without the dot (md, markdown, html, htm, txt, docx).
    ext: String,
}

/// File extensions Vellum can import — kept in sync with the frontend's
/// `formatForExt`. Lowercase, no leading dot.
const IMPORT_EXTS: &[&str] = &["md", "markdown", "html", "htm", "txt", "docx"];

/// Largest single document Vellum will read on import (guards against loading an
/// unintended huge file into memory). A DOCX with embedded images is the biggest
/// realistic case, so the ceiling is generous.
const IMPORT_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// Cap on how many documents one folder import will enumerate.
const IMPORT_MAX_ENTRIES: usize = 5000;

/// Recursively scan `root` for importable documents, skipping dot-directories
/// (e.g. the `.attachments` / `.git` folders an exported wiki carries). Returns
/// entries sorted by relative path so the wizard's section/page order is stable.
/// The picked folder comes from an OS directory dialog.
#[tauri::command]
pub fn import_scan_folder(root: String) -> Result<Vec<ImportEntry>, String> {
    let root = std::path::PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let mut out: Vec<ImportEntry> = Vec::new();
    scan_import_dir(&root, &root, &mut out)?;
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// Recursive worker for `import_scan_folder`. `root` stays fixed (for computing
/// relative paths); `dir` is the folder currently being read.
fn scan_import_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<ImportEntry>,
) -> Result<(), String> {
    if out.len() >= IMPORT_MAX_ENTRIES {
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip dot-entries: `.attachments` (image assets, not pages), `.git`, etc.
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            scan_import_dir(root, &path, out)?;
            if out.len() >= IMPORT_MAX_ENTRIES {
                return Ok(());
            }
        } else if ft.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if !IMPORT_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(ImportEntry {
                rel_path: rel,
                abs_path: path.to_string_lossy().to_string(),
                ext,
            });
            if out.len() >= IMPORT_MAX_ENTRIES {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Read an importable document's raw bytes. `path` is a user-picked file (single
/// import) or one returned by `import_scan_folder` (folder import); size-capped.
/// Returned via `tauri::ipc::Response` (raw bytes → an `ArrayBuffer` on the
/// frontend) rather than a serde `Vec<u8>`: a `Vec<u8>` is JSON-serialized to a
/// number array, which is slow for large files and mangles binary payloads (a
/// `.docx` failed to unzip on the frontend). See Tauri's "Returning Array Buffers".
#[tauri::command]
pub fn import_read_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if meta.len() > IMPORT_MAX_BYTES {
        return Err(format!(
            "File too large to import ({} MB; limit {} MB): {}",
            meta.len() / (1024 * 1024),
            IMPORT_MAX_BYTES / (1024 * 1024),
            path.display()
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// True for references the frontend resolves itself (URLs it keeps as-is, data
/// URIs it decodes) — never a local file to copy.
fn import_ref_is_url(s: &str) -> bool {
    let s = s.trim();
    s.starts_with("//")
        || s.starts_with("http://")
        || s.starts_with("https://")
        || s.starts_with("mailto:")
        || s.starts_with("data:")
}

/// Hex digit → value, for `percent_decode`.
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode `%XX` escapes in a document's image reference (export percent-encodes
/// spaces/parens; other tools encode more). Left intact if a `%` isn't a valid
/// escape. std has no percent-decoder and pulling one in isn't worth a dep here.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Resolve and confine an imported image reference to an on-disk file inside the
/// import root, returning its canonical path — or `None` to skip it: a URL / data
/// URI (handled on the frontend), a missing file, or a path that escapes the
/// root (the traversal guard against a malicious document reading arbitrary
/// files). A leading `/` resolves against `root_dir` (the ADO wiki convention);
/// anything else against `base_dir` (the document's own folder). Split out from
/// the command so the confinement logic is unit-testable without an app handle.
fn resolve_import_image_path(
    base_dir: &str,
    root_dir: &str,
    src_ref: &str,
) -> Option<std::path::PathBuf> {
    let trimmed = src_ref.trim();
    if trimmed.is_empty() || import_ref_is_url(trimmed) {
        return None;
    }
    // Decode escapes and drop any query/fragment, then pick the base to resolve
    // against (root for an absolute-from-root `/…` ref, else the document's dir).
    let decoded = percent_decode(trimmed).replace('\\', "/");
    let decoded = decoded
        .split(['?', '#'])
        .next()
        .unwrap_or(&decoded)
        .to_string();
    let candidate = if let Some(stripped) = decoded.strip_prefix('/') {
        std::path::PathBuf::from(root_dir).join(stripped)
    } else {
        std::path::PathBuf::from(base_dir).join(&decoded)
    };

    // Canonicalize both sides and require containment. `canonicalize` also fails
    // for a missing file, which we treat as "not found" (skip).
    let (Ok(root_canon), Ok(file_canon)) = (
        std::fs::canonicalize(root_dir),
        std::fs::canonicalize(&candidate),
    ) else {
        return None;
    };
    if !file_canon.starts_with(&root_canon) || !file_canon.is_file() {
        return None;
    }
    Some(file_canon)
}

/// Resolve an image reference from an imported document and copy the file into
/// `page_id`'s attachments folder, returning the new notebook-relative path.
/// Returns `None` when the reference is a URL / data URI (handled on the
/// frontend), is missing, or resolves outside the import root (see
/// `resolve_import_image_path`).
#[tauri::command]
pub fn import_copy_external_image(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    base_dir: String,
    root_dir: String,
    src_ref: String,
) -> Result<Option<String>, String> {
    if page_id.is_empty() || page_id.contains('/') || page_id.contains('\\') || page_id.contains("..")
    {
        return Err("Invalid page id".into());
    }
    let Some(file_canon) = resolve_import_image_path(&base_dir, &root_dir, &src_ref) else {
        return Ok(None);
    };

    // Keep only a safe, short extension; default to png (mirrors save_page_image).
    let ext: String = file_canon
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };

    let nb_dir = notebook_folder(&app, &notebook_id)?;
    let rel_out = format!("attachments/{page_id}/{}.{ext}", uuid::Uuid::new_v4());
    let abs_out = nb_dir.join(&rel_out);
    if let Some(parent) = abs_out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::copy(&file_canon, &abs_out).map_err(|e| format!("copy image: {e}"))?;
    Ok(Some(rel_out))
}

/// Harper (`harper-core`) version. harper-core exposes no runtime version
/// constant, so it's maintained here — keep in sync with Cargo.toml when the
/// dependency is bumped (shown in Settings → About).
const HARPER_VERSION: &str = "2.5.0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    /// Vellum app version (Cargo.toml / tauri.conf.json / package.json).
    pub app: String,
    /// Harper grammar engine version.
    pub harper: String,
    /// Pinned Ollama runtime version from the bundled manifest (e.g. "v0.30.10").
    pub ollama: String,
}

/// Versions shown in Settings → About (spec Section 15). The Ollama version is
/// the pinned manifest value, not a check of what's installed.
#[tauri::command]
pub fn get_version_info(app: AppHandle) -> Result<VersionInfo, String> {
    let ollama = crate::refine::manifest::load_manifest(&app)
        .ok()
        .and_then(|m| m.current_ollama().ok().map(|p| p.version.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    Ok(VersionInfo {
        app: env!("CARGO_PKG_VERSION").to_string(),
        harper: HARPER_VERSION.to_string(),
        ollama,
    })
}

/// Reveal the app data folder (`Documents\Vellum`) in the system file manager
/// (Settings → General "Open folder").
#[tauri::command]
pub fn reveal_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = paths::data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open data dir: {e}"))
}

/// Change where Vellum stores all its data (Settings → General). Moves the
/// current data root — `app.json`, `notebooks.json`, the master search index,
/// and every notebook folder — into `<new_parent>\Vellum`, then records that
/// location so it persists across launches. This lets the user keep their data
/// out of a OneDrive-synced folder, avoiding the sync-conflict duplicate copies
/// OneDrive makes of the live SQLite files. Returns the new data-root path; the
/// caller restarts the app so everything reloads from the new location.
#[tauri::command]
pub fn set_data_dir(app: AppHandle, new_parent: String) -> Result<String, String> {
    let current = paths::data_dir(&app)?;
    let parent = std::path::PathBuf::from(new_parent.trim());
    if !parent.is_dir() {
        return Err(format!("Destination is not a folder: {}", parent.display()));
    }
    let new_root = parent.join("Vellum");

    // Already storing data there → nothing to do.
    let same = match (std::fs::canonicalize(&current), std::fs::canonicalize(&new_root)) {
        (Ok(a), Ok(b)) => a == b,
        _ => current == new_root,
    };
    if same {
        return Ok(current.to_string_lossy().to_string());
    }

    // Can't move the data root into a subfolder of itself.
    if new_root.starts_with(&current) {
        return Err("Choose a location outside the current Vellum data folder.".into());
    }

    // Don't overwrite an existing, non-empty "Vellum" folder at the destination.
    if new_root.exists() {
        let empty = std::fs::read_dir(&new_root)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(format!(
                "A \"Vellum\" folder already exists in {} and isn't empty. Choose a different location.",
                parent.display()
            ));
        }
        // Remove the empty folder so the move can create it fresh.
        let _ = std::fs::remove_dir(&new_root);
    }

    if current.is_dir() {
        move_dir(&current, &new_root)?;
    } else {
        std::fs::create_dir_all(&new_root)
            .map_err(|e| format!("create {}: {e}", new_root.display()))?;
    }

    paths::set_data_root(&app, &new_root)?;
    app.state::<AppLog>()
        .info("data", format!("Data location changed to {}", new_root.display()));
    Ok(new_root.to_string_lossy().to_string())
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
        let msg = format!("Notebook database missing: {}", db_path.display());
        app.state::<AppLog>().error("db", msg.as_str());
        return Err(msg);
    }
    match db::integrity_check(&db_path).await {
        Ok(true) => {}
        Ok(false) => {
            let msg = format!(
                "Notebook database failed integrity check: {}",
                db_path.display()
            );
            app.state::<AppLog>().error("db", msg.as_str());
            return Err(msg);
        }
        Err(e) => {
            app.state::<AppLog>()
                .error("db", format!("Integrity check error: {e}"));
            return Err(e);
        }
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

/// A page template's document JSON (spec Section 7), or None if it's missing or
/// not a usable document object.
fn template_value(app: &AppHandle, template_id: &str) -> Option<serde_json::Value> {
    let cfg = config::load_app_config(app).ok()?;
    let tmpl = cfg.page_templates.iter().find(|t| t.id == template_id)?;
    if !tmpl.content_json.is_object() {
        return None;
    }
    Some(tmpl.content_json.clone())
}

/// Values substituted into a page template's one-shot `{{Token}}` placeholders
/// at page-creation time (execution-plan #7). Live date/time fields are a
/// separate Tiptap node (`dynamicField`) and are deliberately left untouched
/// here — they re-evaluate on every page load instead.
struct TemplateTokens {
    page_title: String,
    section_name: String,
    notebook_name: String,
    current_date: String,
    current_time: String,
    current_datetime: String,
}

impl TemplateTokens {
    fn new(page_title: &str, section_name: &str, notebook_name: &str) -> Self {
        let now = chrono::Local::now();
        // These formats match the frontend live-field defaults
        // (src/lib/dynamic-fields.ts) so a one-shot {{CurrentDate}} and a live
        // date field with the default format read identically. chrono's `%-d` /
        // `%-I` (no zero padding) are its own strftime, so they work on Windows.
        let current_date = now.format("%B %-d, %Y").to_string();
        let current_time = now.format("%-I:%M %p").to_string();
        Self {
            current_datetime: format!("{current_date} {current_time}"),
            page_title: page_title.to_string(),
            section_name: section_name.to_string(),
            notebook_name: notebook_name.to_string(),
            current_date,
            current_time,
        }
    }

    /// Replace every known whole token in a string. Unknown `{{…}}` is left as-is.
    fn apply(&self, s: &str) -> String {
        s.replace("{{PageTitle}}", &self.page_title)
            .replace("{{SectionName}}", &self.section_name)
            .replace("{{NotebookName}}", &self.notebook_name)
            .replace("{{CurrentDateTime}}", &self.current_datetime)
            .replace("{{CurrentDate}}", &self.current_date)
            .replace("{{CurrentTime}}", &self.current_time)
    }
}

/// Substitute one-shot `{{Token}}` placeholders inside the text nodes of a Tiptap
/// document (execution-plan #7). Only text-node `text` strings are rewritten, and
/// recursion follows `content` arrays only, so node `type` / `attrs` / `marks`
/// are never touched — live-field nodes (whose data lives in `attrs`, not text)
/// therefore pass through unchanged.
fn substitute_template_tokens(value: &mut serde_json::Value, tokens: &TemplateTokens) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(text)) = map.get_mut("text") {
                *text = tokens.apply(text);
            }
            if let Some(content) = map.get_mut("content") {
                substitute_template_tokens(content, tokens);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                substitute_template_tokens(item, tokens);
            }
            // ProseMirror/Tiptap forbid empty text nodes. A one-shot token that
            // expands to "" and was a node's entire text (e.g. {{PageTitle}} on an
            // untitled new page) would leave `{ "type": "text", "text": "" }`,
            // which makes Tiptap reject the whole document on load — the page then
            // opens blank. Drop any text node emptied by substitution; the
            // surrounding (now possibly childless) paragraph stays valid.
            items.retain(|item| !is_empty_text_node(item));
        }
        _ => {}
    }
}

/// True for a Tiptap text node whose text is the empty string — invalid in
/// ProseMirror, so `substitute_template_tokens` strips these after expanding
/// tokens.
fn is_empty_text_node(value: &serde_json::Value) -> bool {
    value.get("type").and_then(serde_json::Value::as_str) == Some("text")
        && value.get("text").and_then(serde_json::Value::as_str) == Some("")
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

    // If the section has a page template, seed the new page with its content,
    // substituting one-shot {{Token}} placeholders (execution-plan #7). The
    // template itself is never modified — we clone and edit its JSON.
    let template = notebook::section_template_id(&pool, &section_id)
        .await
        .ok()
        .flatten()
        .and_then(|tid| template_value(&app, &tid));
    let applied = if let Some(mut value) = template {
        let section = notebook::section_name(&pool, &section_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        let nb = notebook_name(&app, &notebook_id).unwrap_or_default();
        let tokens = TemplateTokens::new(&title, &section, &nb);
        substitute_template_tokens(&mut value, &tokens);
        let json = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
        let preview: String = crate::search::flatten_text(&json).chars().take(120).collect();
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

/// Delete inline-image files under `attachments/<page_id>/` that the page no
/// longer references. `keep_srcs` is the set of image `src`s still in the live
/// document (notebook-relative paths). Only immediate FILES are considered — the
/// DB-tracked attachments (AttachmentBar) live in per-uuid SUBDIRS and are never
/// touched, and the Recycle Bin isn't involved (these inline images aren't DB-
/// tracked). Returns the number of files removed. Best effort: a file that won't
/// delete is skipped.
#[tauri::command]
pub fn cleanup_page_images(
    app: AppHandle,
    notebook_id: String,
    page_id: String,
    keep_srcs: Vec<String>,
) -> Result<u32, String> {
    if page_id.is_empty() || page_id.contains('/') || page_id.contains('\\') || page_id.contains("..")
    {
        return Err("Invalid page id".into());
    }
    let folder = notebook_folder(&app, &notebook_id)?
        .join("attachments")
        .join(&page_id);
    if !folder.is_dir() {
        return Ok(0);
    }

    // Normalize the keep set to compare against `attachments/<page>/<file>` rels.
    let keep: std::collections::HashSet<String> = keep_srcs
        .into_iter()
        .map(|s| s.replace('\\', "/").trim_start_matches('/').to_string())
        .collect();

    let entries = std::fs::read_dir(&folder).map_err(|e| format!("read_dir: {e}"))?;
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue; // DB-attachment subdirs stay put
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let rel = format!("attachments/{page_id}/{name}");
        if !keep.contains(&rel) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    // Tidy up a now-empty page folder (best effort; ignored if files remain).
    let _ = std::fs::remove_dir(&folder);
    Ok(removed)
}

/// Copy an inline image that belongs to another page into `page_id`'s own
/// attachments folder, returning the new notebook-relative path. Used when an
/// image node is pasted from a different page so each page owns its files (and
/// per-page orphan cleanup can't delete a file another page still references).
#[tauri::command]
pub fn copy_image_to_page(
    app: AppHandle,
    notebook_id: String,
    src_rel: String,
    page_id: String,
) -> Result<String, String> {
    if page_id.is_empty() || page_id.contains('/') || page_id.contains('\\') || page_id.contains("..")
    {
        return Err("Invalid page id".into());
    }
    // The path comes from our own doc, but reject traversal / anything outside
    // the attachments tree defensively.
    let norm = src_rel.replace('\\', "/");
    let norm = norm.trim_start_matches('/');
    if !norm.starts_with("attachments/") || norm.split('/').any(|c| c == "..") {
        return Err("Invalid image path".into());
    }

    let dir = notebook_folder(&app, &notebook_id)?;
    let abs_src = dir.join(norm);
    if !abs_src.is_file() {
        return Err(format!("Image missing: {}", abs_src.display()));
    }

    // Keep only a safe, short extension; default to png.
    let ext: String = norm
        .rsplit('.')
        .next()
        .filter(|e| !e.contains('/'))
        .unwrap_or("png")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect::<String>()
        .to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };

    let rel = format!("attachments/{page_id}/{}.{ext}", uuid::Uuid::new_v4());
    let abs = dir.join(&rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::copy(&abs_src, &abs).map_err(|e| format!("copy image: {e}"))?;
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
    let mut attachments = match notebook::list_attachments(&pool, &page_id).await {
        Ok(a) => a,
        Err(e) => {
            pool.close().await;
            return Err(e);
        }
    };
    // Backfill sizes for rows written before the `size` column existed (they
    // default to 0): stat the file and persist its length so the UI stops
    // showing "0 B". Best-effort — a missing file is left at 0.
    if let Ok(dir) = notebook_folder(&app, &notebook_id) {
        for att in attachments.iter_mut().filter(|a| a.size == 0) {
            if let Ok(meta) = std::fs::metadata(dir.join(&att.path)) {
                let len = meta.len() as i64;
                if len > 0 {
                    let _ = notebook::set_attachment_size(&pool, &att.id, len).await;
                    att.size = len;
                }
            }
        }
    }
    pool.close().await;
    Ok(attachments)
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
pub fn refine_get_manifest(
    app: AppHandle,
) -> Result<crate::refine::manifest::ResolvedManifest, String> {
    crate::refine::manifest::load_manifest(&app)?.resolve_for_current_platform()
}

/// Snapshot of Ollama's recent stderr for the debug panel (spec Section 9).
/// Live lines also arrive on the `refine://ollama-log` event.
#[tauri::command]
pub fn refine_ollama_log(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app.state::<crate::refine::logbuf::LogBuffer>().snapshot())
}

// ---------------------------------------------------------------------------
// Diagnostics / app log (Phase 11)
// ---------------------------------------------------------------------------

/// Recent app-log entries (oldest → newest) for the Settings → About viewer.
#[tauri::command]
pub fn get_app_log(app: AppHandle) -> Vec<LogEntry> {
    app.state::<AppLog>().snapshot()
}

/// Clear the in-memory log view. The on-disk file is kept so a later export
/// still has the durable history.
#[tauri::command]
pub fn clear_app_log(app: AppHandle) {
    app.state::<AppLog>().clear();
}

/// Write the full diagnostic log (on-disk, spanning sessions) to `dest_path`.
#[tauri::command]
pub fn export_app_log(app: AppHandle, dest_path: String) -> Result<(), String> {
    let text = app.state::<AppLog>().export_text();
    std::fs::write(&dest_path, text).map_err(|e| format!("write {dest_path}: {e}"))
}

/// Record a renderer-side event in the app log (routed from the UI's error
/// banner and key catch sites) so one export covers both ends.
#[tauri::command]
pub fn log_frontend_event(app: AppHandle, level: String, area: String, message: String) {
    let log = app.state::<AppLog>();
    match level.as_str() {
        "error" => log.error(&area, message),
        "warn" => log.warn(&area, message),
        _ => log.info(&area, message),
    }
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
    let r = crate::refine::runtime::install_runtime(app.clone()).await;
    if let Err(e) = &r {
        app.state::<AppLog>()
            .error("runtime", format!("Runtime install failed: {e}"));
    }
    r
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway unique temp directory for filesystem tests, removed on drop.
    struct TmpDir(std::path::PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("vellum-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn move_dir_relocates_tree_and_removes_source() {
        let tmp = TmpDir::new();
        let src = tmp.0.join("nb");
        std::fs::create_dir_all(src.join("attachments").join("p1")).unwrap();
        std::fs::write(src.join("notebook.db"), b"db").unwrap();
        std::fs::write(src.join("attachments").join("p1").join("a.png"), b"img").unwrap();

        let dest = tmp.0.join("moved");
        move_dir(&src, &dest).unwrap();

        assert!(!src.exists(), "source folder is removed after the move");
        assert_eq!(std::fs::read(dest.join("notebook.db")).unwrap(), b"db");
        assert_eq!(
            std::fs::read(dest.join("attachments").join("p1").join("a.png")).unwrap(),
            b"img"
        );
    }

    fn tokens() -> TemplateTokens {
        TemplateTokens {
            page_title: "My Page".to_string(),
            section_name: "Meeting Notes".to_string(),
            notebook_name: "Work".to_string(),
            current_date: "July 14, 2026".to_string(),
            current_time: "2:30 PM".to_string(),
            current_datetime: "July 14, 2026 2:30 PM".to_string(),
        }
    }

    #[test]
    fn apply_replaces_whole_tokens_only() {
        let t = tokens();
        assert_eq!(t.apply("{{PageTitle}}"), "My Page");
        assert_eq!(t.apply("Hi {{SectionName}} / {{NotebookName}}"), "Hi Meeting Notes / Work");
        // {{CurrentDateTime}} must resolve to the datetime value, not to
        // {{CurrentDate}} + the literal "Time}}" (replace order guards this).
        assert_eq!(t.apply("{{CurrentDateTime}}"), "July 14, 2026 2:30 PM");
        assert_eq!(
            t.apply("{{CurrentDate}} at {{CurrentTime}}"),
            "July 14, 2026 at 2:30 PM"
        );
        // Unknown tokens are left untouched.
        assert_eq!(t.apply("{{Unknown}} kept"), "{{Unknown}} kept");
    }

    #[test]
    fn substitute_walks_text_nodes_and_skips_attrs() {
        let mut doc = serde_json::json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        { "type": "text", "text": "Title: {{PageTitle}} in {{SectionName}}" },
                        // A live field carries its data in attrs — even an attr that
                        // looks like a token must NOT be substituted.
                        { "type": "dynamicField", "attrs": { "kind": "date", "format": "{{PageTitle}}" } }
                    ]
                },
                {
                    "type": "heading",
                    "attrs": { "level": 1 },
                    "content": [ { "type": "text", "text": "{{NotebookName}}" } ]
                }
            ]
        });

        substitute_template_tokens(&mut doc, &tokens());

        let para = &doc["content"][0]["content"];
        assert_eq!(para[0]["text"], "Title: My Page in Meeting Notes");
        // The dynamicField node passes through unchanged (attrs untouched, no text).
        assert_eq!(para[1]["type"], "dynamicField");
        assert_eq!(para[1]["attrs"]["format"], "{{PageTitle}}");
        // Nested content is reached.
        assert_eq!(doc["content"][1]["content"][0]["text"], "Work");
    }

    #[test]
    fn substitute_drops_text_nodes_emptied_by_a_token() {
        // {{PageTitle}} on an untitled new page expands to "" — the resulting
        // empty text node must be removed, or Tiptap rejects the whole doc on
        // load ("Empty text nodes are not allowed") and the page opens blank.
        let empty_title = TemplateTokens {
            page_title: String::new(),
            section_name: "Sec".to_string(),
            notebook_name: "NB".to_string(),
            current_date: "D".to_string(),
            current_time: "T".to_string(),
            current_datetime: "DT".to_string(),
        };
        let mut doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [ { "type": "text", "text": "{{PageTitle}}" } ] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "By {{PageTitle}}" },
                    { "type": "text", "text": "{{PageTitle}}" }
                ]}
            ]
        });

        substitute_template_tokens(&mut doc, &empty_title);

        // The lone {{PageTitle}} paragraph keeps no children (a valid empty para).
        assert_eq!(doc["content"][0]["content"].as_array().unwrap().len(), 0);
        // "By {{PageTitle}}" -> "By " (kept); the trailing emptied node is dropped.
        let p2 = doc["content"][1]["content"].as_array().unwrap();
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0]["text"], "By ");
    }

    #[test]
    fn new_formats_match_live_field_defaults() {
        // The real clock values vary, but the shape must match the frontend
        // live-field default presets (src/lib/dynamic-fields.ts).
        let t = TemplateTokens::new("P", "S", "N");
        assert!(t.current_date.contains(", "), "date like \"July 14, 2026\"");
        assert!(
            t.current_time.ends_with("AM") || t.current_time.ends_with("PM"),
            "12-hour time with AM/PM"
        );
        assert_eq!(t.current_datetime, format!("{} {}", t.current_date, t.current_time));
    }

    // --- Import (execution-plan #4) ----------------------------------------

    #[test]
    fn percent_decode_reverses_escapes_and_passes_through_literals() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode(".attachments/my%20image%281%29.png"), ".attachments/my image(1).png");
        // A stray or malformed `%` is left as-is (not a valid escape).
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn import_ref_is_url_flags_only_remote_or_inline() {
        assert!(import_ref_is_url("https://example.com/a.png"));
        assert!(import_ref_is_url("http://example.com/a.png"));
        assert!(import_ref_is_url("//cdn/a.png"));
        assert!(import_ref_is_url("data:image/png;base64,AAAA"));
        assert!(import_ref_is_url("mailto:x@y.z"));
        // Local references (relative, root-absolute, Windows-absolute) are NOT urls.
        assert!(!import_ref_is_url(".attachments/a.png"));
        assert!(!import_ref_is_url("/.attachments/a.png"));
        assert!(!import_ref_is_url("images/a.png"));
        assert!(!import_ref_is_url(r"C:\images\a.png"));
    }

    #[test]
    fn import_scan_folder_filters_ext_and_skips_dot_dirs() {
        let tmp = TmpDir::new();
        let root = &tmp.0;
        std::fs::write(root.join("page.md"), b"# Page").unwrap();
        std::fs::write(root.join("notes.txt"), b"text").unwrap();
        std::fs::write(root.join("ignore.pdf"), b"no").unwrap();
        std::fs::create_dir_all(root.join("Section A")).unwrap();
        std::fs::write(root.join("Section A").join("child.markdown"), b"# Child").unwrap();
        // A dot-directory (an exported wiki's image store) must be skipped.
        std::fs::create_dir_all(root.join(".attachments")).unwrap();
        std::fs::write(root.join(".attachments").join("hidden.md"), b"# nope").unwrap();

        let mut entries = import_scan_folder(root.to_string_lossy().to_string()).unwrap();
        entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let rels: Vec<&str> = entries.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["Section A/child.markdown", "notes.txt", "page.md"]);
        // Extensions are lowercased, no dot; the `.pdf` and dot-dir file are gone.
        assert!(entries.iter().all(|e| e.ext != "pdf"));
        assert!(entries.iter().any(|e| e.ext == "markdown"));
    }

    #[test]
    fn resolve_import_image_confines_to_root() {
        let tmp = TmpDir::new();
        let root = tmp.0.join("wiki");
        let sub = root.join("Section");
        std::fs::create_dir_all(root.join(".attachments")).unwrap();
        std::fs::create_dir_all(sub.join(".attachments")).unwrap();
        std::fs::write(root.join(".attachments").join("logo.png"), b"png").unwrap();
        std::fs::write(sub.join(".attachments").join("pic.png"), b"png").unwrap();
        // A secret OUTSIDE the import root that a malicious doc might target.
        std::fs::write(tmp.0.join("secret.txt"), b"secret").unwrap();

        let root_s = root.to_string_lossy().to_string();
        let sub_s = sub.to_string_lossy().to_string();

        // Relative ref resolves against the document's own folder.
        assert!(resolve_import_image_path(&sub_s, &root_s, ".attachments/pic.png").is_some());
        // A leading `/` resolves against the import root (ADO wiki convention).
        assert!(resolve_import_image_path(&sub_s, &root_s, "/.attachments/logo.png").is_some());
        // Percent-encoded names decode before resolving.
        std::fs::write(sub.join(".attachments").join("a b.png"), b"png").unwrap();
        assert!(resolve_import_image_path(&sub_s, &root_s, ".attachments/a%20b.png").is_some());

        // Traversal escaping the root is refused, even though the file exists.
        assert!(resolve_import_image_path(&sub_s, &root_s, "../../secret.txt").is_none());
        // URLs / data URIs / missing files are skipped.
        assert!(resolve_import_image_path(&sub_s, &root_s, "https://x/y.png").is_none());
        assert!(resolve_import_image_path(&sub_s, &root_s, "data:image/png;base64,AA").is_none());
        assert!(resolve_import_image_path(&sub_s, &root_s, ".attachments/missing.png").is_none());
    }
}

