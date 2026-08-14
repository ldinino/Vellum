//! Whole-Satchel transfer (phase A).
//!
//! The flow is: acquire the lease, pull, work, then checkpoint, push, release.
//! Because the lease makes one device the writer, a pull can treat the remote
//! as authoritative and a push can treat the local copy as authoritative — the
//! only case needing care is when the remote moved on behind our back, which is
//! detected by generation rather than guessed at from timestamps.
//!
//! **SQLite is the hard part.** `notebook.db` is opaque to rclone, and in WAL
//! mode the `.db` file alone is not a complete snapshot: the recent writes live
//! in `notebook.db-wal`. Copying just the `.db` yields a database missing the
//! last edits; copying all three risks a torn set. So every push closes the
//! pools, folds the WAL back in with `wal_checkpoint(TRUNCATE)`, and excludes
//! the sidecar files from the transfer.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::rclone;

const STATE_FILE: &str = "state.json";

/// Files that must never cross the wire.
///
/// - `-wal` / `-shm`: SQLite sidecars, folded into the `.db` by the checkpoint;
///   shipping them invites a torn database.
/// - `lease.json` / `state.json`: sync's own bookkeeping, owned by the remote.
///   Without these exclusions `rclone sync` would delete the remote's lease as
///   an "extra" file on every push.
/// - `search-index.db`: rebuildable from the notebooks, so syncing it is pure
///   cost and a needless conflict surface.
/// - `*.tmp`: half-written files from an interrupted atomic write.
const EXCLUDES: &[&str] = &[
    "*-wal",
    "*-shm",
    "lease.json",
    "state.json",
    "search-index.db",
    "search-index.db-*",
    "*.tmp",
];

/// Bookkeeping shared with the remote so both sides can tell whether the other
/// has moved on. Held separately from the lease because it outlives it: the
/// lease says who is writing *now*, this says what was last written.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// Incremented on every successful push. A remote generation ahead of ours
    /// means somebody else pushed since we last pulled.
    pub generation: u64,
    pub device_id: String,
    pub device_name: String,
    pub synced_at: String,
}

/// Why a sync stopped without transferring.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncOutcome {
    Completed {
        state: SyncState,
        /// Notebooks that could not be checkpointed and were shipped as they
        /// were; surfaced so a damaged file doesn't fail silently.
        skipped: Vec<String>,
    },
    /// The remote moved on since our last pull; the caller must preserve the
    /// local copy before overwriting it.
    Conflict { local: u64, remote: u64 },
}

fn args_with_excludes<'a>(base: &[&'a str]) -> Vec<String> {
    let mut args: Vec<String> = base.iter().map(|s| (*s).to_string()).collect();
    for pattern in EXCLUDES {
        args.push("--exclude".into());
        args.push((*pattern).to_string());
    }
    args
}

fn as_str_args(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn state_path(target: &str) -> String {
    let sep = if target.ends_with(':') || target.ends_with('/') { "" } else { "/" };
    format!("{target}{sep}{STATE_FILE}")
}

pub fn read_remote_state(
    env: &[(String, String)],
    target: &str,
) -> Result<Option<SyncState>, String> {
    if !rclone::list(env, target)?.iter().any(|l| l == STATE_FILE) {
        return Ok(None);
    }
    let out = rclone::run(env, &["cat", &state_path(target)])?;
    serde_json::from_str(&out.stdout)
        .map(Some)
        .map_err(|_| "The sync bookkeeping on the storage is unreadable.".to_string())
}

fn write_remote_state(
    env: &[(String, String)],
    target: &str,
    state: &SyncState,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("serialize state: {e}"))?;
    rclone::run_with_stdin(env, &["rcat", &state_path(target)], &json).map(|_| ())
}

/// Fold every notebook's WAL back into its database file.
///
/// Must run with all pools closed: an open connection keeps the WAL alive, so
/// `TRUNCATE` cannot complete and the copied `.db` would be missing recent
/// edits.
///
/// A file that won't *open* as SQLite is skipped rather than fatal — it has no
/// WAL to fold in, so copying it as-is is no worse than leaving it behind, and
/// one damaged notebook must not block syncing the rest forever. A database
/// that opens but won't *checkpoint* does abort: that means the WAL is still
/// live (something else holds it), and copying then yields a stale or torn
/// database, which is worse than not syncing at all.
pub async fn checkpoint_all(satchel_dir: &Path) -> Result<Vec<String>, String> {
    let mut skipped = Vec::new();
    for db in notebook_databases(satchel_dir) {
        let pool = match crate::db::open_pool(&db, false).await {
            Ok(pool) => pool,
            Err(e) => {
                skipped.push(format!("{}: {e}", db.display()));
                continue;
            }
        };
        let result = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .map_err(|e| {
                format!(
                    "{} is still in use, so its recent changes can't be safely copied: {e}",
                    db.display()
                )
            });
        pool.close().await;
        result?;
    }
    Ok(skipped)
}

fn notebook_databases(satchel_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(satchel_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path().join("notebook.db"))
        .filter(|p| p.is_file())
        .collect()
}

/// Send the local Satchel to the remote. Assumes the lease is held and the
/// pools are already closed.
pub async fn push(
    env: &[(String, String)],
    target: &str,
    satchel_dir: &Path,
    local_generation: u64,
    device: &super::device::Device,
) -> Result<SyncOutcome, String> {
    let remote_state = read_remote_state(env, target)?.unwrap_or_default();
    if remote_state.generation > local_generation {
        return Ok(SyncOutcome::Conflict {
            local: local_generation,
            remote: remote_state.generation,
        });
    }

    let skipped = checkpoint_all(satchel_dir).await?;

    let local = satchel_dir.to_string_lossy().into_owned();
    let args = args_with_excludes(&["sync", &local, target]);
    rclone::run(env, &as_str_args(&args))?;

    let next = SyncState {
        generation: remote_state.generation + 1,
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        synced_at: chrono::Utc::now().to_rfc3339(),
    };
    write_remote_state(env, target, &next)?;
    Ok(SyncOutcome::Completed { state: next, skipped })
}

/// True if anything under the Satchel changed after `since`.
///
/// Used to decide whether a pull would destroy local work. It is a heuristic —
/// mtimes can lie — but it errs toward preserving a copy, which is the safe
/// direction.
pub fn has_changes_since(satchel_dir: &Path, since: &str) -> bool {
    let Ok(cutoff) = chrono::DateTime::parse_from_rfc3339(since) else {
        // Unknown last-sync time: assume there is work worth protecting.
        return true;
    };
    let cutoff: std::time::SystemTime = cutoff.with_timezone(&chrono::Utc).into();
    newest_modification(satchel_dir).is_some_and(|newest| newest > cutoff)
}

fn newest_modification(dir: &Path) -> Option<std::time::SystemTime> {
    let mut newest: Option<std::time::SystemTime> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            // The search index is rewritten constantly and never synced, so it
            // would make every Satchel look permanently modified.
            if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("search-index.db"))
            {
                continue;
            }
            if let Ok(modified) = meta.modified() {
                if newest.is_none_or(|n| modified > n) {
                    newest = Some(modified);
                }
            }
        }
    }
    newest
}

/// Bring the local Satchel in line with the remote.
///
/// **This deletes local files the remote doesn't have** — that is what makes it
/// a sync rather than a merge, and it is why callers must only pull when the
/// remote is strictly ahead, and must preserve a copy first if local work would
/// be destroyed. The caller must also have closed the pools: we are about to
/// replace database files underneath them.
pub fn pull(
    env: &[(String, String)],
    target: &str,
    satchel_dir: &Path,
) -> Result<SyncState, String> {
    let remote_state = read_remote_state(env, target)?.unwrap_or_default();
    let local = satchel_dir.to_string_lossy().into_owned();
    let args = args_with_excludes(&["sync", target, &local]);
    rclone::run(env, &as_str_args(&args))?;
    Ok(remote_state)
}

/// Preserve the local Satchel beside itself before a pull overwrites it. The
/// copy is a normal folder the user can open as its own Satchel, so nothing is
/// ever silently lost to a conflict.
pub fn preserve_conflict_copy(
    satchel_dir: &Path,
    device_name: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Result<PathBuf, String> {
    let parent = satchel_dir
        .parent()
        .ok_or_else(|| "the Satchel has no parent folder".to_string())?;
    let name = satchel_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Vellum".into());
    let stamp = now.format("%Y-%m-%d %H%M");
    // The folder name is something the user reads, so it says what the window
    // says (docs 5.5) rather than what this function is called.
    let mut dest = parent.join(format!("{name} (unsent changes {stamp} from {device_name})"));
    // Two copies in the same minute must not merge into one folder.
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{name} (unsent changes {stamp} from {device_name}) {n}"));
        n += 1;
    }
    copy_dir_all(satchel_dir, &dest)
        .map_err(|e| format!("could not preserve a copy at {}: {e}", dest.display()))?;
    Ok(dest)
}

fn copy_dir_all(src: &Path, dest: &Path) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn device(name: &str) -> super::super::device::Device {
        super::super::device::Device { id: format!("id-{name}"), name: name.into() }
    }

    fn local_remote(dir: &Path) -> (Vec<(String, String)>, String) {
        let config = super::super::remote::RemoteConfig {
            backend: "local".into(),
            label: "Local".into(),
            options: BTreeMap::new(),
            path: dir.to_string_lossy().into_owned(),
            crypt_password: rclone::obscure("p1").unwrap(),
            crypt_password2: rclone::obscure("p2").unwrap(),
        };
        (config.env_vars(), config.target())
    }

    fn temp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("vellum-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn excludes_cover_the_sqlite_sidecars_and_remote_bookkeeping() {
        let args = args_with_excludes(&["sync", "a", "b"]);
        let joined = args.join(" ");
        for pattern in ["*-wal", "*-shm", "lease.json", "state.json", "search-index.db"] {
            assert!(joined.contains(pattern), "missing exclusion {pattern}: {joined}");
        }
    }

    #[test]
    fn state_path_handles_both_target_shapes() {
        assert_eq!(state_path("vellumcrypt:"), "vellumcrypt:state.json");
        assert_eq!(state_path("vellumcrypt:notes"), "vellumcrypt:notes/state.json");
    }

    #[tokio::test]
    async fn push_then_pull_moves_the_satchel_and_advances_the_generation() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let store = temp("engine-store");
        let source = temp("engine-src");
        let (env, target) = local_remote(&store);

        std::fs::write(source.join("app.json"), b"{}").unwrap();
        std::fs::create_dir_all(source.join("nb")).unwrap();
        // A real database, so the checkpoint exercises the actual path.
        crate::db::create_or_migrate(&source.join("nb").join("notebook.db"))
            .await
            .unwrap();
        // Sidecars and the rebuildable index must not travel.
        std::fs::write(source.join("nb").join("notebook.db-wal"), b"wal").unwrap();
        std::fs::write(source.join("search-index.db"), b"idx").unwrap();

        let outcome = push(&env, &target, &source, 0, &device("LAPTOP")).await.unwrap();
        let state = match outcome {
            SyncOutcome::Completed { state, .. } => state,
            other => panic!("expected Completed, got {other:?}"),
        };
        assert_eq!(state.generation, 1);

        let dest = temp("engine-dst");
        let pulled = pull(&env, &target, &dest).unwrap();
        assert_eq!(pulled.generation, 1);
        assert!(dest.join("app.json").is_file());
        assert!(dest.join("nb").join("notebook.db").is_file());
        assert!(!dest.join("nb").join("notebook.db-wal").exists(), "WAL sidecar was synced");
        assert!(!dest.join("search-index.db").exists(), "search index was synced");

        for d in [store, source, dest] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// One damaged notebook must not block syncing everything else, or a single
    /// bad file would strand the user's whole Satchel forever.
    #[tokio::test]
    async fn a_file_that_is_not_a_database_is_skipped_rather_than_fatal() {
        let dir = temp("engine-damaged");
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        std::fs::write(dir.join("broken").join("notebook.db"), b"not a database").unwrap();
        std::fs::create_dir_all(dir.join("good")).unwrap();
        crate::db::create_or_migrate(&dir.join("good").join("notebook.db"))
            .await
            .unwrap();

        let skipped = checkpoint_all(&dir).await.expect("must not abort");
        assert_eq!(skipped.len(), 1, "expected exactly the broken notebook: {skipped:?}");
        assert!(skipped[0].contains("broken"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_remote_that_moved_on_is_reported_as_a_conflict_not_overwritten() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let store = temp("engine-store");
        let desktop_dir = temp("engine-desktop");
        let (env, target) = local_remote(&store);

        std::fs::write(desktop_dir.join("app.json"), b"{desktop}").unwrap();
        push(&env, &target, &desktop_dir, 0, &device("DESKTOP")).await.unwrap();

        // LAPTOP still thinks the remote is at generation 0.
        let laptop_dir = temp("engine-laptop");
        std::fs::write(laptop_dir.join("app.json"), b"{laptop}").unwrap();
        let outcome = push(&env, &target, &laptop_dir, 0, &device("LAPTOP")).await.unwrap();
        assert_eq!(outcome, SyncOutcome::Conflict { local: 0, remote: 1 });

        // The remote still holds DESKTOP's copy — nothing was overwritten.
        let check = temp("engine-check");
        pull(&env, &target, &check).unwrap();
        assert_eq!(std::fs::read(check.join("app.json")).unwrap(), b"{desktop}");

        for d in [store, desktop_dir, laptop_dir, check] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// `rclone sync` makes the destination match the source, deleting anything
    /// extra. The remote's own bookkeeping lives at that destination, so if the
    /// exclusions did not also protect it, every push would wipe the lease and
    /// the generation counter — losing conflict detection entirely.
    #[tokio::test]
    async fn a_second_push_does_not_delete_the_remote_lease_or_state() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let store = temp("engine-keep-store");
        let source = temp("engine-keep-src");
        let (env, target) = local_remote(&store);
        let me = device("LAPTOP");

        std::fs::write(source.join("app.json"), b"{}").unwrap();
        push(&env, &target, &source, 0, &me).await.unwrap();

        // Something the lease module would have written.
        rclone::run_with_stdin(
            &env,
            &["rcat", &format!("{target}lease.json")],
            "{\"deviceId\":\"x\"}",
        )
        .unwrap();

        std::fs::write(source.join("app.json"), b"{changed}").unwrap();
        let outcome = push(&env, &target, &source, 1, &me).await.unwrap();
        assert!(matches!(outcome, SyncOutcome::Completed { .. }), "{outcome:?}");

        let listing = rclone::run(&env, &["lsf", &target]).unwrap().stdout;
        assert!(listing.contains("lease.json"), "the push deleted the lease: {listing}");
        assert!(listing.contains("state.json"), "the push deleted the state: {listing}");
        assert_eq!(
            read_remote_state(&env, &target).unwrap().unwrap().generation,
            2
        );

        for d in [store, source] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// `pull` is destructive by design, so the guard that decides *whether* to
    /// pull has to be right: a Satchel with unpushed edits must be recognised.
    #[test]
    fn local_changes_after_the_last_sync_are_detected() {
        let dir = temp("engine-changes");
        std::fs::write(dir.join("app.json"), b"{}").unwrap();

        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(!has_changes_since(&dir, &future), "nothing is newer than an hour ahead");

        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        assert!(has_changes_since(&dir, &past), "an existing file is newer than an hour ago");

        // An unparseable timestamp must err toward preserving work.
        assert!(has_changes_since(&dir, "not a date"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// The search index is rewritten constantly and never synced, so counting it
    /// would make every Satchel look permanently modified and force a conflict
    /// copy on every single open.
    #[test]
    fn the_rebuildable_search_index_does_not_count_as_a_change() {
        let dir = temp("engine-index");
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        std::fs::write(dir.join("search-index.db"), b"idx").unwrap();
        assert!(
            !has_changes_since(&dir, &past),
            "the search index was treated as user work"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn conflict_copies_are_preserved_side_by_side() {
        let parent = temp("engine-parent");
        let satchel = parent.join("Vellum");
        std::fs::create_dir_all(satchel.join("nb")).unwrap();
        std::fs::write(satchel.join("nb").join("notebook.db"), b"mine").unwrap();

        let now = chrono::Local::now();
        let first = preserve_conflict_copy(&satchel, "LAPTOP", now).unwrap();
        assert_eq!(std::fs::read(first.join("nb").join("notebook.db")).unwrap(), b"mine");

        // A second conflict in the same minute must not land in the same folder.
        let second = preserve_conflict_copy(&satchel, "LAPTOP", now).unwrap();
        assert_ne!(first, second);
        assert!(second.is_dir());

        // Both spellings of the name are read by the person who finds the
        // folder, so both say what the window says (docs 5.5).
        for dir in [&first, &second] {
            let shown = dir.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                shown.contains("(unsent changes ") && !shown.contains("conflict"),
                "the folder the user sees is named {shown}"
            );
        }

        let _ = std::fs::remove_dir_all(parent);
    }
}
