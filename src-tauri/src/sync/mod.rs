//! BYO sync (docs/satchels-and-sync.md, phase A).
//!
//! Scope is the whole Satchel — settings travel with it, so `app.json` is part
//! of the synced payload and the single-writer lease is per-Satchel rather than
//! per-notebook.
//!
//! This module is the orchestration seam: the submodules stay ignorant of Tauri
//! so they can be tested directly, and everything needing an `AppHandle` lives
//! here.

pub mod code;
pub mod device;
pub mod engine;
pub mod lease;
pub mod providers;
pub mod rclone;
pub mod remote;
pub mod secrets;

#[cfg(test)]
mod lifecycle_tests;

use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};

use crate::applog::AppLog;
use crate::{paths, satchel};

/// What Settings ▸ Sync shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    /// Provider label, e.g. "Backblaze B2". Never the rclone backend name.
    pub label: Option<String>,
    pub last_synced_at: Option<String>,
    /// Set when another device is actively using this Satchel.
    pub held_by: Option<String>,
    pub held_since: Option<String>,
    /// Set when sealed credentials exist but can't be read on this machine.
    pub error: Option<String>,
}

/// Outcome of a sync the user asked for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub synced: bool,
    /// Set when the local copy was preserved because the remote had moved on.
    pub conflict_copy: Option<String>,
    /// Notebooks that couldn't be checkpointed and were shipped as they were.
    pub skipped: Vec<String>,
}

fn active_satchel_id(app: &AppHandle) -> Result<String, String> {
    let list = satchel::load_list(app)?;
    if list.active_id.is_empty() {
        return Err("No Satchel is open.".into());
    }
    Ok(list.active_id)
}

fn load_remote(app: &AppHandle) -> Result<Option<remote::RemoteConfig>, String> {
    remote::load(&satchel::machine_dir(app)?, &active_satchel_id(app)?)
}

pub fn this_device(app: &AppHandle) -> Result<device::Device, String> {
    device::get_or_create(&satchel::machine_dir(app)?)
}

fn binding(app: &AppHandle) -> Result<Option<satchel::SyncBinding>, String> {
    let list = satchel::load_list(app)?;
    Ok(list
        .known
        .iter()
        .find(|s| s.id == list.active_id)
        .and_then(|s| s.sync.clone()))
}

/// Record the binding in `satchels.json` so the picker can draw the cloud badge
/// for a Satchel that isn't open. Credentials never go here.
fn set_binding(app: &AppHandle, value: Option<satchel::SyncBinding>) -> Result<(), String> {
    let mut list = satchel::load_list(app)?;
    let id = list.active_id.clone();
    if let Some(entry) = list.known.iter_mut().find(|s| s.id == id) {
        entry.sync = value;
    }
    satchel::save_list(app, &list)
}

pub fn status(app: &AppHandle) -> Result<SyncStatus, String> {
    let blank = SyncStatus {
        configured: false,
        label: None,
        last_synced_at: None,
        held_by: None,
        held_since: None,
        error: None,
    };
    let config = match load_remote(app) {
        Ok(Some(c)) => c,
        Ok(None) => return Ok(blank),
        // Sealed credentials that won't open (copied profile, different user)
        // must be reported, not silently shown as "not synced".
        Err(e) => return Ok(SyncStatus { configured: true, error: Some(e), ..blank }),
    };

    let last_synced_at = binding(app)?.and_then(|b| b.last_synced_at);

    // Lease state needs the network; a failure here must not make the panel
    // unusable, so it degrades to "no known holder".
    let me = this_device(app)?;
    let (held_by, held_since) =
        match lease::state(&config.env_vars(), &config.target(), &me, chrono::Utc::now()) {
            Ok(lease::LeaseState::Held(l)) => (Some(l.device_name), Some(l.acquired_at)),
            _ => (None, None),
        };

    Ok(SyncStatus {
        configured: true,
        label: Some(config.label),
        last_synced_at,
        held_by,
        held_since,
        error: None,
    })
}

/// Build a remote from a provider form, prove it works, then save it.
///
/// The probe is not optional: a credential that merely authenticates is not
/// enough — a read-only key or a missing bucket both authenticate and then fail
/// at first sync, which is far harder to diagnose than failing here.
pub fn configure(
    app: &AppHandle,
    provider_id: &str,
    values: BTreeMap<String, String>,
    path: &str,
) -> Result<(), String> {
    let provider = providers::by_id(provider_id)
        .ok_or_else(|| format!("Unknown storage provider '{provider_id}'."))?;
    if path.trim().is_empty() {
        return Err(format!("Enter a {}.", provider.path_label.to_lowercase()));
    }

    let mut options = provider.fixed.clone();
    let secret_keys = providers::obscured_keys(&provider);
    for field in &provider.fields {
        let value = values.get(&field.key).map(String::as_str).unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        let stored = if secret_keys.contains(&field.key) {
            rclone::obscure(value)?
        } else {
            value.to_string()
        };
        options.insert(field.key.clone(), stored);
    }

    let (p1, p2) = remote::generate_crypt_passwords()?;
    let config = remote::RemoteConfig {
        backend: provider.backend.clone(),
        label: provider.label.clone(),
        options,
        path: path.trim().to_string(),
        crypt_password: p1,
        crypt_password2: p2,
    };

    rclone::probe(&config.env_vars(), &config.target())?;
    save_remote(app, &config)
}

fn save_remote(app: &AppHandle, config: &remote::RemoteConfig) -> Result<(), String> {
    remote::save(&satchel::machine_dir(app)?, &active_satchel_id(app)?, config)?;
    set_binding(
        app,
        Some(satchel::SyncBinding {
            remote: "vellumcrypt".into(),
            label: config.label.clone(),
            last_synced_at: None,
            generation: 0,
        }),
    )?;
    app.state::<AppLog>()
        .info("sync", format!("Sync configured with {}", config.label));
    Ok(())
}

/// The current remote as a pasteable code. Fails when nothing is configured,
/// rather than handing back a code that unlocks nothing.
pub fn connection_code(app: &AppHandle, passphrase: &str) -> Result<String, String> {
    let config = load_remote(app)?.ok_or_else(|| "This Satchel isn't synced yet.".to_string())?;
    code::encode(&config, passphrase)
}

/// Adopt a remote from another device's code, after proving it works here.
pub fn apply_connection_code(    app: &AppHandle,
    code_text: &str,
    passphrase: &str,
) -> Result<(), String> {
    let config = code::decode(code_text, passphrase)?;
    rclone::probe(&config.env_vars(), &config.target())?;
    save_remote(app, &config)
}

/// Forget the remote on this machine. Touches nothing on the storage provider
/// and nothing inside the Satchel.
pub fn stop(app: &AppHandle) -> Result<(), String> {
    remote::delete(&satchel::machine_dir(app)?, &active_satchel_id(app)?)?;
    set_binding(app, None)?;
    app.state::<AppLog>().info("sync", "Sync turned off for this Satchel");
    Ok(())
}

/// Push the active Satchel: take the lease, checkpoint, transfer, release.
pub async fn sync_now(app: &AppHandle, take_over: bool) -> Result<SyncReport, String> {
    let config = load_remote(app)?.ok_or_else(|| "This Satchel isn't synced yet.".to_string())?;
    let env = config.env_vars();
    let target = config.target();
    let me = this_device(app)?;
    let now = chrono::Utc::now();

    if let lease::LeaseState::Held(l) = lease::state(&env, &target, &me, now)? {
        if !take_over {
            return Err(format!(
                "{} is using this Satchel right now. Syncing would risk losing their changes.",
                l.device_name
            ));
        }
    }
    lease::acquire(&env, &target, &me, now)?;

    // Every database handle has to be released before the WAL can be folded
    // back in, or the copy ships without the most recent edits.
    app.state::<crate::db::PoolCache>().clear().await;

    let satchel_dir = paths::data_dir(app)?;
    let generation = binding(app)?.map(|b| b.generation).unwrap_or(0);

    let result = match engine::push(&env, &target, &satchel_dir, generation, &me).await {
        Ok(engine::SyncOutcome::Completed { state, skipped }) => {
            set_binding(
                app,
                Some(satchel::SyncBinding {
                    remote: "vellumcrypt".into(),
                    label: config.label.clone(),
                    last_synced_at: Some(state.synced_at.clone()),
                    generation: state.generation,
                }),
            )?;
            if !skipped.is_empty() {
                app.state::<AppLog>()
                    .warn("sync", format!("Copied as-is (not checkpointed): {}", skipped.join("; ")));
            }
            Ok(SyncReport { synced: true, conflict_copy: None, skipped })
        }
        Ok(engine::SyncOutcome::Conflict { local, remote }) => {
            let copy =
                engine::preserve_conflict_copy(&satchel_dir, &me.name, chrono::Local::now())?;
            app.state::<AppLog>().warn(
                "sync",
                format!("Conflict (local {local}, remote {remote}); local copy preserved"),
            );
            Ok(SyncReport {
                synced: false,
                conflict_copy: Some(copy.to_string_lossy().into_owned()),
                skipped: Vec::new(),
            })
        }
        Err(e) => Err(e),
    };

    // Release even when the push failed, or a crash-free error would still lock
    // the Satchel out until the lease went stale.
    let _ = lease::release(&env, &target, &me);
    result
}

/// Take the lease and bring the local Satchel in line with the remote.
///
/// Runs when a synced Satchel is opened. Returns `Ok(None)` when the Satchel
/// isn't synced, so callers can treat "no sync configured" as ordinary rather
/// than as a failure.
pub async fn begin_session(app: &AppHandle) -> Result<Option<SyncReport>, String> {
    let Some(config) = load_remote(app)? else {
        return Ok(None);
    };
    let env = config.env_vars();
    let target = config.target();
    let me = this_device(app)?;
    let now = chrono::Utc::now();

    if let lease::LeaseState::Held(l) = lease::state(&env, &target, &me, now)? {
        // Opening read-only would be a lie: the editor saves as you type. Better
        // to say plainly that the other device is in charge and change nothing.
        return Err(format!(
            "{} is using this Satchel right now, so it hasn't been updated from the cloud.",
            l.device_name
        ));
    }
    lease::acquire(&env, &target, &me, now)?;

    let current = binding(app)?;
    let local_generation = current.as_ref().map(|b| b.generation).unwrap_or(0);
    let remote_state = engine::read_remote_state(&env, &target)?.unwrap_or_default();

    // Pulling at an equal generation would silently revert edits made offline
    // since the last push, so only a strictly newer remote is worth pulling.
    if remote_state.generation <= local_generation {
        return Ok(Some(SyncReport {
            synced: false,
            conflict_copy: None,
            skipped: Vec::new(),
        }));
    }

    let satchel_dir = paths::data_dir(app)?;
    // No recorded sync time means this Satchel has never been pushed, so
    // everything in it is unpushed work.
    let local_work_at_risk = match current.as_ref().and_then(|b| b.last_synced_at.as_deref()) {
        Some(since) => engine::has_changes_since(&satchel_dir, since),
        None => satchel_dir.is_dir(),
    };
    let conflict_copy = if local_work_at_risk {
        let copy = engine::preserve_conflict_copy(&satchel_dir, &me.name, chrono::Local::now())?;
        app.state::<AppLog>().warn(
            "sync",
            format!("Local changes preserved at {} before pulling", copy.display()),
        );
        Some(copy.to_string_lossy().into_owned())
    } else {
        None
    };

    // The pull is about to replace database files, so nothing may hold them.
    app.state::<crate::db::PoolCache>().clear().await;

    let state = engine::pull(&env, &target, &satchel_dir)?;
    set_binding(
        app,
        Some(satchel::SyncBinding {
            remote: "vellumcrypt".into(),
            label: config.label.clone(),
            last_synced_at: Some(state.synced_at.clone()),
            generation: state.generation,
        }),
    )?;
    app.state::<AppLog>()
        .info("sync", format!("Pulled generation {}", state.generation));
    Ok(Some(SyncReport { synced: true, conflict_copy, skipped: Vec::new() }))
}

/// Refresh our claim while the app is open. `false` means another device took
/// the Satchel over and this one must stop writing to the remote.
pub fn refresh_lease(app: &AppHandle) -> Result<bool, String> {
    let Some(config) = load_remote(app)? else {
        return Ok(true);
    };
    let me = this_device(app)?;
    lease::heartbeat(
        &config.env_vars(),
        &config.target(),
        &me,
        chrono::Utc::now(),
    )
}

/// Hand the Satchel back on a clean exit, so the next device isn't locked out
/// for the full staleness window. Never removes another device's lease.
pub fn release_lease(app: &AppHandle) -> Result<(), String> {
    let Some(config) = load_remote(app)? else {
        return Ok(());
    };
    let me = this_device(app)?;
    lease::release(&config.env_vars(), &config.target(), &me)
}

/// Version of the bundled transfer engine, for Settings ▸ About.
pub fn support_version() -> String {
    rclone::version().unwrap_or_else(|_| "not available".into())
}
