//! Satchels — self-contained Vellum data roots.
//!
//! A Satchel holds everything: `app.json` (settings, templates, dictionary),
//! `notebooks.json`, and one folder per notebook. A user can keep several and
//! switch between them; switching relaunches the app rather than hot-swapping,
//! so no cache, pool or asset-protocol scope has to be invalidated.
//!
//! Identity lives in a marker file (`satchel.json`) inside the folder, not in
//! the folder name — so a Satchel moved in Explorer is recognised as the same
//! one instead of being added twice. The *list* of known Satchels is
//! machine-local (`%LOCALAPPDATA%\Vellum\satchels.json`), because a good path
//! differs between machines; everything else travels with the folder.
//!
//! Replaces the older single-root pointer file `data-location.txt`, which is
//! migrated on first launch (see `migrate_legacy_pointer`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::config::write_json_atomic;

pub const MARKER_FILE: &str = "satchel.json";

/// Bumped when the on-disk layout of a Satchel changes incompatibly. A Satchel
/// marked newer than this is refused rather than opened — cheap insurance once
/// folders travel between machines running different versions.
pub const FORMAT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

/// `<satchel>/satchel.json`. `id` is stable forever and survives moves and
/// renames; `name` travels with the folder so every machine shows the same
/// label.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    #[serde(default = "default_name")]
    pub name: String,
    #[serde(default = "default_format_version")]
    pub format_version: u32,
}

fn default_name() -> String {
    "Vellum".into()
}

fn default_format_version() -> u32 {
    FORMAT_VERSION
}

/// `%LOCALAPPDATA%\Vellum\satchels.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SatchelList {
    pub active_id: String,
    pub known: Vec<KnownSatchel>,
}

/// A remembered Satchel. `name` and `path` are a cache for rendering the picker
/// before any Satchel is opened; the marker file is authoritative and refreshes
/// them on open.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KnownSatchel {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Sync binding, once BYO sync ships. Credentials never live here — only
    /// enough to show the cloud badge and its tooltip for a Satchel that isn't
    /// open. `None` = local-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync: Option<SyncBinding>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncBinding {
    /// rclone remote name (an implementation detail; never shown raw).
    pub remote: String,
    /// Human label for the provider, e.g. "Backblaze B2".
    pub label: String,
    pub last_synced_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Startup status
// ---------------------------------------------------------------------------

/// Why the active Satchel could not be opened at startup. Recorded in managed
/// state for the frontend to collect, which then shows a chooser. We never fall
/// back to a fresh empty root in these cases — that reads as data loss.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SatchelProblem {
    /// "missing" — the folder isn't there (disconnected drive, unsynced cloud
    /// folder); "tooNew" — written by a newer Vellum.
    pub kind: String,
    pub name: String,
    pub path: String,
}

/// Managed state holding the startup problem, if any.
#[derive(Default)]
pub struct StartupStatus(pub Mutex<Option<SatchelProblem>>);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn local_vellum_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("cannot resolve local data directory: {e}"))?;
    Ok(local.join("Vellum"))
}

pub fn list_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(local_vellum_dir(app)?.join("satchels.json"))
}

/// Pre-Satchel single-root pointer, migrated then deleted.
fn legacy_pointer_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(local_vellum_dir(app)?.join("data-location.txt"))
}

/// `Documents\Vellum` — where a first-run Satchel is created.
pub fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("cannot resolve Documents directory: {e}"))?;
    Ok(docs.join("Vellum"))
}

pub fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_FILE)
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

pub fn read_marker(dir: &Path) -> Result<Marker, String> {
    let path = marker_path(dir);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    // Tolerate a UTF-8 BOM — the folder may be touched by external editors.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn write_marker(dir: &Path, marker: &Marker) -> Result<(), String> {
    write_json_atomic(&marker_path(dir), marker)
}

pub fn load_list(app: &AppHandle) -> Result<SatchelList, String> {
    let path = list_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            serde_json::from_str(text).map_err(|e| format!("parse {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SatchelList::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub fn save_list(app: &AppHandle, list: &SatchelList) -> Result<(), String> {
    write_json_atomic(&list_path(app)?, list)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// The active Satchel's folder. Called by `paths::data_dir` on every command,
/// so it stays a single small file read and never creates anything.
pub fn active_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let list = load_list(app)?;
    match list.known.iter().find(|s| s.id == list.active_id) {
        Some(s) => Ok(PathBuf::from(&s.path)),
        None => default_root(app),
    }
}

/// Adopt `dir` as a Satchel: create it if absent, reuse its marker if it
/// already has one, else write a fresh marker with a new id.
fn ensure_satchel_at(dir: &Path, fallback_name: &str) -> Result<KnownSatchel, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let marker = match read_marker(dir) {
        Ok(m) => m,
        Err(_) => {
            let m = Marker {
                id: uuid::Uuid::new_v4().to_string(),
                name: fallback_name.to_string(),
                format_version: FORMAT_VERSION,
            };
            write_marker(dir, &m)?;
            m
        }
    };
    Ok(KnownSatchel {
        id: marker.id,
        name: marker.name,
        path: dir.to_string_lossy().to_string(),
        sync: None,
    })
}

/// Turn a pre-Satchel install into a one-Satchel list. Silent: no prompt, no
/// data movement. Only runs when `satchels.json` doesn't exist yet.
fn migrate_legacy_pointer(app: &AppHandle) -> Result<(), String> {
    if list_path(app)?.exists() {
        return Ok(());
    }
    let pointer = legacy_pointer_path(app)?;
    let root = match std::fs::read_to_string(&pointer) {
        Ok(text) if !text.trim().is_empty() => PathBuf::from(text.trim()),
        _ => default_root(app)?,
    };
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(default_name);
    let entry = ensure_satchel_at(&root, &name)?;
    save_list(
        app,
        &SatchelList { active_id: entry.id.clone(), known: vec![entry] },
    )?;
    let _ = std::fs::remove_file(&pointer);
    Ok(())
}

/// Resolve (and if necessary create) the active Satchel at startup. Returns the
/// problem to surface to the user, if any; `None` means the app can proceed.
pub fn resolve_at_startup(app: &AppHandle) -> Result<Option<SatchelProblem>, String> {
    migrate_legacy_pointer(app)?;
    let mut list = load_list(app)?;

    // Nothing known (fresh install) → create the default Satchel.
    if list.known.is_empty() {
        let entry = ensure_satchel_at(&default_root(app)?, &default_name())?;
        list.active_id = entry.id.clone();
        list.known = vec![entry];
        save_list(app, &list)?;
        return Ok(None);
    }

    // Active id dangling (hand-edited file) → fall back to the first known one.
    if !list.known.iter().any(|s| s.id == list.active_id) {
        list.active_id = list.known[0].id.clone();
        save_list(app, &list)?;
    }

    let idx = list.known.iter().position(|s| s.id == list.active_id).unwrap();
    let path = PathBuf::from(&list.known[idx].path);
    if !path.is_dir() {
        return Ok(Some(SatchelProblem {
            kind: "missing".into(),
            name: list.known[idx].name.clone(),
            path: list.known[idx].path.clone(),
        }));
    }

    match read_marker(&path) {
        Ok(marker) if marker.format_version > FORMAT_VERSION => Ok(Some(SatchelProblem {
            kind: "tooNew".into(),
            name: marker.name,
            path: list.known[idx].path.clone(),
        })),
        Ok(marker) => {
            // The marker is authoritative — refresh the cached label, but only
            // write when it actually changed so we don't churn the file on
            // every launch.
            if list.known[idx].name != marker.name || list.known[idx].id != marker.id {
                list.known[idx].name = marker.name;
                list.known[idx].id = marker.id.clone();
                list.active_id = marker.id;
                save_list(app, &list)?;
            }
            Ok(None)
        }
        Err(_) => {
            // Folder is there but has no readable marker — an upgraded install
            // or a hand-made folder. Self-heal by writing one with the id we
            // already track, so the entry keeps its identity.
            let entry = &list.known[idx];
            write_marker(
                &path,
                &Marker {
                    id: if entry.id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        entry.id.clone()
                    },
                    name: if entry.name.is_empty() { default_name() } else { entry.name.clone() },
                    format_version: FORMAT_VERSION,
                },
            )?;
            Ok(None)
        }
    }
}

// ---------------------------------------------------------------------------
// Mutations (backing the Settings ▸ General commands)
// ---------------------------------------------------------------------------

/// Strip characters Windows forbids in a folder name, so a Satchel called
/// "Work: 2026" doesn't fail to create.
pub fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() {
        default_name()
    } else {
        cleaned
    }
}

/// True if `dir` is inside, or is, an existing Satchel. Nested Satchels are a
/// trap (the inner one would be walked as notebook data), so creation refuses.
fn is_within_satchel(dir: &Path) -> bool {
    let mut cursor = Some(dir);
    while let Some(d) = cursor {
        if marker_path(d).is_file() {
            return true;
        }
        cursor = d.parent();
    }
    false
}

/// Add an entry, or update the path of one already known by the same id (the
/// "moved in Explorer" case). Returns the stored entry.
fn upsert(list: &mut SatchelList, entry: KnownSatchel) -> KnownSatchel {
    match list.known.iter_mut().find(|s| s.id == entry.id) {
        Some(existing) => {
            existing.path = entry.path;
            existing.name = entry.name;
            existing.clone()
        }
        None => {
            list.known.push(entry.clone());
            entry
        }
    }
}

pub fn create(
    app: &AppHandle,
    parent: &Path,
    name: &str,
    copy_settings: bool,
) -> Result<KnownSatchel, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Satchel name cannot be empty".into());
    }
    if !parent.is_dir() {
        return Err(format!("Not a folder: {}", parent.display()));
    }
    if is_within_satchel(parent) {
        return Err("That folder is inside another Satchel. Choose a location outside it.".into());
    }
    let dir = parent.join(sanitize_folder_name(name));
    if dir.exists() {
        let empty = std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !empty {
            return Err(format!(
                "\"{}\" already exists in {} and isn't empty. Choose a different name.",
                dir.file_name().unwrap_or_default().to_string_lossy(),
                parent.display()
            ));
        }
    }

    let settings = if copy_settings {
        Some(crate::config::load_app_config(app)?)
    } else {
        None
    };

    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let marker = Marker {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        format_version: FORMAT_VERSION,
    };
    // Past this point the folder exists; roll it back on any failure so a
    // failed create can't leave an orphan behind.
    if let Err(e) = seed_new_satchel(&dir, &marker, settings) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    let entry = KnownSatchel {
        id: marker.id,
        name: marker.name,
        path: dir.to_string_lossy().to_string(),
        sync: None,
    };
    let mut list = load_list(app)?;
    let stored = upsert(&mut list, entry);
    save_list(app, &list)?;
    Ok(stored)
}

/// Write the marker and an empty notebook registry into a brand-new Satchel,
/// plus a copy of the current settings when asked for.
fn seed_new_satchel(
    dir: &Path,
    marker: &Marker,
    settings: Option<crate::config::AppConfig>,
) -> Result<(), String> {
    write_marker(dir, marker)?;
    write_json_atomic(&dir.join("notebooks.json"), &crate::config::NotebookRegistry::default())?;
    if let Some(mut config) = settings {
        // Carry appearance, proofing, dictionary and templates across — but not
        // the once-only gates, so the new Satchel seeds its own Welcome
        // notebook and starter templates and shows first run if it hasn't.
        config.settings.welcome_seeded = false;
        config.settings.starters_seeded = false;
        write_json_atomic(&dir.join("app.json"), &config)?;
    }
    Ok(())
}

/// Open an existing folder as a Satchel. Without `adopt`, a folder that has no
/// marker is rejected so the UI can offer to create one there.
pub fn open(app: &AppHandle, dir: &Path, adopt: bool) -> Result<KnownSatchel, String> {
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }
    let marker = match read_marker(dir) {
        Ok(m) => m,
        Err(_) if adopt => {
            if is_within_satchel(dir) {
                return Err(
                    "That folder is inside another Satchel. Choose a location outside it.".into(),
                );
            }
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(default_name);
            let m = Marker {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                format_version: FORMAT_VERSION,
            };
            write_marker(dir, &m)?;
            m
        }
        Err(_) => return Err(NOT_A_SATCHEL.into()),
    };
    if marker.format_version > FORMAT_VERSION {
        return Err(format!(
            "\"{}\" was made by a newer version of Vellum. Update Vellum to open it.",
            marker.name
        ));
    }

    let mut list = load_list(app)?;
    let stored = upsert(
        &mut list,
        KnownSatchel {
            id: marker.id,
            name: marker.name,
            path: dir.to_string_lossy().to_string(),
            sync: None,
        },
    );
    save_list(app, &list)?;
    Ok(stored)
}

/// Sentinel the frontend matches on to offer "Create a Satchel here?".
pub const NOT_A_SATCHEL: &str = "NOT_A_SATCHEL";

pub fn set_active(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut list = load_list(app)?;
    if !list.known.iter().any(|s| s.id == id) {
        return Err(format!("Unknown Satchel {id}"));
    }
    list.active_id = id.to_string();
    save_list(app, &list)
}

/// Drop a Satchel from this machine's list. Never touches the folder.
pub fn forget(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut list = load_list(app)?;
    if list.active_id == id {
        return Err("You can't remove the Satchel you're currently using.".into());
    }
    list.known.retain(|s| s.id != id);
    save_list(app, &list)
}

pub fn rename(app: &AppHandle, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Satchel name cannot be empty".into());
    }
    let mut list = load_list(app)?;
    let entry = list
        .known
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown Satchel {id}"))?;
    entry.name = name.to_string();
    let dir = PathBuf::from(&entry.path);
    let id = entry.id.clone();
    save_list(app, &list)?;
    // The marker is authoritative and travels with the folder, so it has to
    // carry the new name too; a missing folder just leaves the cached label.
    if dir.is_dir() {
        write_marker(
            &dir,
            &Marker { id, name: name.to_string(), format_version: FORMAT_VERSION },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway unique temp directory, removed on drop.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("vellum-satchel-{}", uuid::Uuid::new_v4()));
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
    fn sanitizes_illegal_folder_characters() {
        assert_eq!(sanitize_folder_name("Work: 2026"), "Work_ 2026");
        assert_eq!(sanitize_folder_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_folder_name("  trailing.  "), "trailing");
        assert_eq!(sanitize_folder_name("***"), "___");
        assert_eq!(sanitize_folder_name("   "), "Vellum");
    }

    #[test]
    fn marker_round_trips_and_keeps_its_id() {
        let tmp = TmpDir::new();
        let first = ensure_satchel_at(&tmp.0, "Work").unwrap();
        let again = ensure_satchel_at(&tmp.0, "Ignored").unwrap();
        assert_eq!(first.id, again.id, "an existing marker is reused, not replaced");
        assert_eq!(again.name, "Work", "the marker's own name wins");
        assert!(marker_path(&tmp.0).is_file());
    }

    #[test]
    fn marker_tolerates_a_utf8_bom() {
        let tmp = TmpDir::new();
        std::fs::write(
            marker_path(&tmp.0),
            "\u{feff}{\"id\":\"abc\",\"name\":\"BOM\",\"formatVersion\":1}",
        )
        .unwrap();
        assert_eq!(read_marker(&tmp.0).unwrap().name, "BOM");
    }

    #[test]
    fn nested_satchels_are_detected() {
        let tmp = TmpDir::new();
        ensure_satchel_at(&tmp.0, "Outer").unwrap();
        let inner = tmp.0.join("notebooks").join("deep");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(is_within_satchel(&inner));

        let sibling = TmpDir::new();
        assert!(!is_within_satchel(&sibling.0));
    }

    #[test]
    fn a_moved_satchel_updates_its_path_instead_of_duplicating() {
        let mut list = SatchelList::default();
        upsert(
            &mut list,
            KnownSatchel {
                id: "same".into(),
                name: "Work".into(),
                path: "C:\\old".into(),
                sync: None,
            },
        );
        let moved = upsert(
            &mut list,
            KnownSatchel {
                id: "same".into(),
                name: "Work".into(),
                path: "D:\\new".into(),
                sync: None,
            },
        );
        assert_eq!(list.known.len(), 1);
        assert_eq!(moved.path, "D:\\new");
        assert_eq!(list.known[0].path, "D:\\new");
    }

    #[test]
    fn a_new_satchel_gets_a_registry_and_reseeds_its_own_starters() {
        let tmp = TmpDir::new();
        let dir = tmp.0.join("Dev");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = Marker {
            id: "new".into(),
            name: "Dev".into(),
            format_version: FORMAT_VERSION,
        };
        let mut source = crate::config::AppConfig::default();
        source.settings.welcome_seeded = true;
        source.settings.starters_seeded = true;
        source.settings.theme = "98".into();

        seed_new_satchel(&dir, &marker, Some(source)).unwrap();

        assert!(dir.join("notebooks.json").is_file());
        let copied: crate::config::AppConfig =
            serde_json::from_str(&std::fs::read_to_string(dir.join("app.json")).unwrap()).unwrap();
        assert_eq!(copied.settings.theme, "98", "settings travel");
        assert!(!copied.settings.welcome_seeded, "the new Satchel seeds its own Welcome");
        assert!(!copied.settings.starters_seeded);
    }
}
