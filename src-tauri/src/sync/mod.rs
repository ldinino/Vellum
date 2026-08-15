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
pub mod presence;
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
    /// False when sync is gated off in this build; the UI hides itself entirely.
    pub available: bool,
    pub configured: bool,
    /// Provider label, e.g. "Backblaze B2". Never the rclone backend name.
    pub label: Option<String>,
    pub last_synced_at: Option<String>,
    /// Set when another device is actively using this Satchel.
    pub held_by: Option<String>,
    pub held_since: Option<String>,
    /// Set when sealed credentials exist but can't be read on this machine.
    pub error: Option<String>,
    /// This Satchel lives inside a OneDrive folder, so OneDrive and Vellum would
    /// both be syncing the same live databases.
    pub onedrive_conflict: bool,
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

/// What the heartbeat found, as the window needs to hear it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseStanding {
    /// True while this device still holds the lease.
    pub held: bool,
    /// The device that took the Satchel over, when one did. Only this means
    /// stand down: a lease that is merely absent is the ordinary state between
    /// syncs, and a network failure surfaces as an error instead.
    pub taken_over_by: Option<String>,
}

/// How this device came to be without the Satchel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HoldReason {
    /// Another device took it over while we were open.
    TakenOver,
    /// Another device already had it when this window opened.
    OnArrival,
}

/// Records that another device has the Satchel, whether it took it over while we
/// were open or already had it when we arrived.
///
/// This is the guard, and it lives in the backend on purpose: the close handler,
/// Settings ▸ Sync and every mutating command funnel through it, so refusing
/// here is the only way to be sure nothing writes over the new holder — a guard
/// that only the window applies is not a guard.
#[derive(Default)]
pub struct StandDown(std::sync::Mutex<Option<(String, HoldReason)>>);

impl StandDown {
    /// The device that took over, if this session has stood down.
    ///
    /// Deliberately blind to [`HoldReason::OnArrival`]: arriving to a held
    /// Satchel leaves the push path exactly as it was, where the refusal comes
    /// from the lease and carries the wording that offers a take-over.
    pub fn taken_over_by(&self) -> Option<String> {
        match self.0.lock().map(|g| g.clone()).unwrap_or(None) {
            Some((name, HoldReason::TakenOver)) => Some(name),
            _ => None,
        }
    }

    /// The device that has the Satchel, however this session lost it.
    pub fn held_by(&self) -> Option<String> {
        self.0.lock().map(|g| g.clone()).unwrap_or(None).map(|(n, _)| n)
    }

    pub fn record(&self, device_name: String) {
        self.set(device_name, HoldReason::TakenOver);
    }

    /// Another device had it before we opened (docs 5.7): structural edits are
    /// refused the same way, and this is the one place that fact lives.
    pub fn record_on_arrival(&self, device_name: String) {
        self.set(device_name, HoldReason::OnArrival);
    }

    fn set(&self, device_name: String, reason: HoldReason) {
        if let Ok(mut g) = self.0.lock() {
            *g = Some((device_name, reason));
        }
    }

    /// Only an explicit take-back clears this.
    pub fn clear(&self) {
        if let Ok(mut g) = self.0.lock() {
            *g = None;
        }
    }
}

/// Whether sync is available at all in this build.
///
/// Shipped builds hide it until it is finished; a debug build always has it, so
/// development doesn't depend on remembering to flip a flag.
pub fn is_enabled(app: &AppHandle) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    crate::config::load_app_config(app)
        .map(|c| c.settings.sync_enabled)
        .unwrap_or(false)
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
    let onedrive_conflict = paths::data_dir(app)
        .map(|d| satchel::is_onedrive_path(&d))
        .unwrap_or(false);
    let blank = SyncStatus {
        available: is_enabled(app),
        configured: false,
        label: None,
        last_synced_at: None,
        held_by: None,
        held_since: None,
        error: None,
        onedrive_conflict,
    };
    if !blank.available {
        return Ok(blank);
    }
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
        available: true,
        configured: true,
        label: Some(config.label),
        last_synced_at,
        held_by,
        held_since,
        error: None,
        onedrive_conflict,
    })
}

/// How long to wait for someone to finish signing in before giving up. Long
/// enough to find a password and pick an account; short enough that a forgotten
/// browser tab doesn't leave a helper process running all day.
const SIGN_IN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

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
    if provider.oauth {
        // Opens the browser and blocks until the person finishes; the token
        // comes back to us and is sealed like any other credential, never
        // written to an rclone config.
        let token = rclone::authorize(&provider.backend, SIGN_IN_TIMEOUT)?;
        options.insert("token".to_string(), token);
    }
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

/// How the product says "another device has this Satchel"
/// (docs/satchels-and-sync.md 5.5). The window matches on this prefix to tell a
/// take-over apart from any other sync failure, so it is a contract: keep it in
/// step with `SATCHEL_IN_USE` in SyncSettings.tsx.
pub const IN_USE_PREFIX: &str = "This Satchel is open on";

fn in_use(device_name: &str, consequence: &str) -> String {
    format!("{IN_USE_PREFIX} {device_name}. {consequence}")
}

/// Refuse to touch the remote while another device has the Satchel.
///
/// Both the push and the opening pull go through here so there is one wording
/// and one rule; ignoring the result is an `unused_must_use` warning.
fn refuse_if_held(state: &lease::LeaseState, consequence: &str) -> Result<(), String> {
    match state {
        lease::LeaseState::Held(l) => Err(in_use(&l.device_name, consequence)),
        lease::LeaseState::Available(_) => Ok(()),
    }
}

/// What the window says while another device has the Satchel (docs 5.5).
pub const EDITING_PAUSED: &str = "Editing is paused here.";

/// Whether this device may change anything in the Satchel (docs 5.7 LOCKALL).
///
/// Read-only has to mean read-only: a section created while another device holds
/// the Satchel is written locally, and the next pull preserves it into a sibling
/// Satchel the user never asked for. Refusing in the backend covers every route
/// in — menu, context menu, drag, keyboard — with one rule.
pub fn edits_permitted(guard: &StandDown) -> Result<(), String> {
    match guard.held_by() {
        Some(holder) => Err(in_use(&holder, EDITING_PAUSED)),
        None => Ok(()),
    }
}

/// Whether a push may leave this device.
///
/// Split out from [`sync_now`] because that needs an `AppHandle`, and this is
/// the rule the whole feature turns on.
fn push_permitted(guard: &StandDown, take_over: bool) -> Result<PushPermit, String> {
    match guard.taken_over_by() {
        Some(holder) if !take_over => Err(format!(
            "{holder} took this Satchel over, so this device can no longer save to your storage."
        )),
        _ => Ok(PushPermit),
    }
}

/// Proof that the guard was consulted. [`push_permitted`] is the only thing
/// that makes one and [`push_satchel`] is the only thing that takes one, so a
/// push that skips the guard does not compile — a test can only catch that
/// after someone has written it.
#[must_use]
#[derive(Debug)]
struct PushPermit;

async fn push_satchel(
    _permit: &PushPermit,
    env: &[(String, String)],
    target: &str,
    satchel_dir: &std::path::Path,
    generation: u64,
    me: &device::Device,
) -> Result<engine::SyncOutcome, String> {
    engine::push(env, target, satchel_dir, generation, me).await
}

/// Turn a heartbeat into what the window is told, arming the push guard when
/// — and only when — another device has taken the Satchel.
fn standing_outcome(standing: lease::Standing, guard: &StandDown) -> LeaseStanding {
    match standing {
        lease::Standing::Ours => LeaseStanding { held: true, taken_over_by: None },
        lease::Standing::Vacant => LeaseStanding { held: false, taken_over_by: None },
        lease::Standing::TakenOver(l) => {
            guard.record(l.device_name.clone());
            LeaseStanding { held: false, taken_over_by: Some(l.device_name) }
        }
    }
}

/// Push the active Satchel: take the lease, checkpoint, transfer, release.
pub async fn sync_now(app: &AppHandle, take_over: bool) -> Result<SyncReport, String> {
    // Another device is in charge of this Satchel. Pushing would write over
    // work it has already done, so nothing but an explicit take-over gets past
    // here — including the push the window runs on close.
    let stood_down = app.state::<StandDown>();
    let permit = push_permitted(&stood_down, take_over)?;
    stood_down.clear();

    let config = load_remote(app)?.ok_or_else(|| "This Satchel isn't synced yet.".to_string())?;
    let env = config.env_vars();
    let target = config.target();
    let me = this_device(app)?;
    let now = chrono::Utc::now();

    if !take_over {
        refuse_if_held(
            &lease::state(&env, &target, &me, now)?,
            "Syncing now would risk losing the changes made there.",
        )?;
    }
    lease::acquire(&env, &target, &me, now)?;

    // Every database handle has to be released before the WAL can be folded
    // back in, or the copy ships without the most recent edits.
    app.state::<crate::db::PoolCache>().clear().await;

    let satchel_dir = paths::data_dir(app)?;
    let generation = binding(app)?.map(|b| b.generation).unwrap_or(0);

    let result = match push_satchel(&permit, &env, &target, &satchel_dir, generation, &me).await {
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
    if !is_enabled(app) {
        return Ok(None);
    }
    let Some(config) = load_remote(app)? else {
        return Ok(None);
    };
    let env = config.env_vars();
    let target = config.target();
    let me = this_device(app)?;
    let now = chrono::Utc::now();

    // Opening read-only would be a lie: the editor saves as you type. Better to
    // say plainly that the other device has it and change nothing.
    let standing = lease::state(&env, &target, &me, now)?;
    // Arm the same guard the take-over path arms, so "another device has this
    // Satchel" has one home in the backend rather than being re-derived in the
    // window from the text of this error (docs 5.7).
    if let lease::LeaseState::Held(l) = &standing {
        app.state::<StandDown>()
            .record_on_arrival(l.device_name.clone());
    }
    refuse_if_held(&standing, "It hasn't been updated from your storage.")?;
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

/// Refresh our claim while the app is open.
///
/// `taken_over_by` set means another device holds the Satchel and this one must
/// stand down; the guard is armed here so no later push can slip out.
pub fn refresh_lease(app: &AppHandle) -> Result<LeaseStanding, String> {
    let held = LeaseStanding { held: true, taken_over_by: None };
    if !is_enabled(app) {
        return Ok(held);
    }
    let Some(config) = load_remote(app)? else {
        return Ok(held);
    };
    let me = this_device(app)?;
    let standing = lease::heartbeat(
        &config.env_vars(),
        &config.target(),
        &me,
        chrono::Utc::now(),
    )?;
    let outcome = standing_outcome(standing, &app.state::<StandDown>());
    if let Some(holder) = &outcome.taken_over_by {
        app.state::<AppLog>().warn(
            "sync",
            format!("{holder} took the Satchel over; this session is read-only"),
        );
    }
    Ok(outcome)
}

/// Keep this session's unsynced work as a conflict Satchel beside the current
/// one — the same preservation §2 uses on a losing pull, so there is only ever
/// one mechanism for "don't lose my edits".
pub async fn preserve_local_copy(app: &AppHandle) -> Result<String, String> {
    let me = this_device(app)?;
    let satchel_dir = paths::data_dir(app)?;
    // A copy taken with the WAL still outstanding would miss the most recent
    // edits, which are exactly the ones being preserved.
    app.state::<crate::db::PoolCache>().clear().await;
    engine::checkpoint_all(&satchel_dir).await?;
    let copy = engine::preserve_conflict_copy(&satchel_dir, &me.name, chrono::Local::now())?;
    app.state::<AppLog>().warn(
        "sync",
        format!("Unsynced work preserved at {}", copy.display()),
    );
    Ok(copy.to_string_lossy().into_owned())
}

/// Take the Satchel back after standing down. Deliberately only ever a response
/// to the user asking: re-acquiring on our own would fight the other device for
/// the lease.
pub fn take_back(app: &AppHandle) -> Result<(), String> {
    let config = load_remote(app)?.ok_or_else(|| "This Satchel isn't synced yet.".to_string())?;
    let me = this_device(app)?;
    lease::acquire(&config.env_vars(), &config.target(), &me, chrono::Utc::now())?;
    app.state::<StandDown>().clear();
    app.state::<AppLog>()
        .info("sync", "Satchel taken back by this device");
    Ok(())
}

/// Hand the Satchel back on a clean exit, so the next device isn't locked out
/// for the full staleness window. Never removes another device's lease.
pub fn release_lease(app: &AppHandle) -> Result<(), String> {
    if !is_enabled(app) {
        return Ok(());
    }
    let Some(config) = load_remote(app)? else {
        return Ok(());
    };
    let me = this_device(app)?;
    lease::release(&config.env_vars(), &config.target(), &me)
}

/// Hand the Satchel over on the way out of the room (docs 5.2).
///
/// The departing device knows it is being left long before the arriving one
/// knows it wants in, so this is a final sync followed by letting go — the same
/// thing closing the window does, minus the closing. [`sync_now`] releases the
/// lease when it finishes, push or no push, so there is only one release path.
pub async fn yield_lease(app: &AppHandle) -> Result<(), String> {
    if !is_enabled(app) || load_remote(app)?.is_none() {
        return Ok(());
    }
    // Already stood down: the Satchel is not ours to hand over, and the backend
    // would refuse the push anyway.
    if app.state::<StandDown>().taken_over_by().is_some() {
        return Ok(());
    }
    sync_now(app, false).await.map(|_| ())
}

/// What to do about the lease we find on returning to a yielded device.
#[derive(Debug, Clone, PartialEq)]
enum Resume {
    /// Nobody has it, it is already ours, or the holder went stale.
    Reacquire,
    /// Somebody moved in while we were away.
    StandDown(lease::Lease),
}

/// Separated from the round trip so the decision is testable. Taking an absent
/// or stale lease straight back is the entire point of yielding; finding a live
/// holder has to land in STANDDOWN's existing path rather than fight for it.
fn resume_action(state: lease::LeaseState) -> Resume {
    match state {
        lease::LeaseState::Held(l) => Resume::StandDown(l),
        lease::LeaseState::Available(_) => Resume::Reacquire,
    }
}

/// Take the Satchel back after yielding it.
///
/// Optimistic on purpose: the window never stopped accepting edits, so this
/// runs in the background and only ever reports back. Blocking on a network
/// round trip every time you sit down would trade one bad feeling for another.
pub fn resume_session(app: &AppHandle) -> Result<LeaseStanding, String> {
    let held = LeaseStanding { held: true, taken_over_by: None };
    if !is_enabled(app) {
        return Ok(held);
    }
    let Some(config) = load_remote(app)? else {
        return Ok(held);
    };
    let env = config.env_vars();
    let target = config.target();
    let me = this_device(app)?;
    let now = chrono::Utc::now();

    match resume_action(lease::state(&env, &target, &me, now)?) {
        Resume::Reacquire => {
            lease::acquire(&env, &target, &me, now)?;
            app.state::<AppLog>()
                .info("sync", "Satchel taken back after yielding");
            Ok(held)
        }
        // Route through the same mapping the heartbeat uses, so the push guard
        // is armed the one way it is armed everywhere else.
        Resume::StandDown(l) => Ok(standing_outcome(
            lease::Standing::TakenOver(l),
            &app.state::<StandDown>(),
        )),
    }
}

/// Version of the bundled transfer engine, for Settings ▸ About.
pub fn support_version() -> String {
    rclone::version().unwrap_or_else(|_| "not available".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease_of(name: &str) -> lease::Lease {
        lease::Lease {
            device_id: format!("id-{name}"),
            device_name: name.to_string(),
            acquired_at: "2026-08-12T09:00:00Z".into(),
            heartbeat_at: "2026-08-12T09:00:00Z".into(),
        }
    }

    #[test]
    fn only_a_take_over_stands_the_session_down() {
        let guard = StandDown::default();
        let ours = standing_outcome(lease::Standing::Ours, &guard);
        assert!(ours.held);
        assert_eq!(guard.taken_over_by(), None);

        // `sync_now` releases the lease when it finishes, so an absent lease is
        // the ordinary state between syncs. Reading it as a take-over would put
        // the user into read-only after every successful sync.
        let vacant = standing_outcome(lease::Standing::Vacant, &guard);
        assert!(!vacant.held);
        assert_eq!(vacant.taken_over_by, None);
        assert_eq!(guard.taken_over_by(), None, "a vacant lease armed the guard");

        let taken = standing_outcome(lease::Standing::TakenOver(lease_of("DESKTOP")), &guard);
        assert_eq!(taken.taken_over_by.as_deref(), Some("DESKTOP"));
        assert_eq!(guard.taken_over_by().as_deref(), Some("DESKTOP"));
    }

    #[test]
    fn returning_takes_the_lease_back_unless_somebody_moved_in() {
        // The ordinary case: yielding deleted our lease, so there is nothing
        // there and we simply take it again. No prompt, no wait.
        assert_eq!(resume_action(lease::LeaseState::Available(None)), Resume::Reacquire);
        // Our own lease still sitting there (a yield whose release failed) and
        // another device's stale one are both `Available` — take both back.
        assert_eq!(
            resume_action(lease::LeaseState::Available(Some(lease_of("US")))),
            Resume::Reacquire
        );

        // Somebody is actually there. This must not be re-acquired: it is the
        // take-over STANDDOWN already handles.
        let taken = resume_action(lease::LeaseState::Held(lease_of("LAPTOP")));
        assert_eq!(taken, Resume::StandDown(lease_of("LAPTOP")));

        // And it arms the push guard through the same mapping the heartbeat
        // uses, so a resumed session can no more push than a stood-down one.
        let guard = StandDown::default();
        let Resume::StandDown(l) = taken else { panic!("expected a take-over") };
        let outcome = standing_outcome(lease::Standing::TakenOver(l), &guard);
        assert_eq!(outcome.taken_over_by.as_deref(), Some("LAPTOP"));
        assert!(!outcome.held);
        assert_eq!(guard.taken_over_by().as_deref(), Some("LAPTOP"));
        assert!(push_permitted(&guard, false).is_err(), "a resumed take-over could still push");
    }

    #[test]
    fn the_refusal_names_the_machine_in_the_wording_the_window_matches() {
        let held = lease::LeaseState::Held(lease_of("DESKTOP-01"));
        let refused = refuse_if_held(&held, "Editing is paused here.").expect_err("allowed");
        assert_eq!(refused, "This Satchel is open on DESKTOP-01. Editing is paused here.");
        // SyncSettings.tsx tells a take-over apart from any other sync failure
        // by this prefix; the old "is using this Satchel" wording is gone.
        assert!(refused.starts_with(IN_USE_PREFIX));
        assert!(!refused.contains("is using this Satchel"));

        // Our own lease, a stale one and no lease at all are all ordinary.
        assert!(refuse_if_held(&lease::LeaseState::Available(None), "x").is_ok());
        assert!(
            refuse_if_held(&lease::LeaseState::Available(Some(lease_of("US"))), "x").is_ok()
        );
    }

    #[test]
    fn a_stood_down_device_pushes_only_when_the_user_takes_over() {
        let guard = StandDown::default();
        assert!(push_permitted(&guard, false).is_ok());

        guard.record("DESKTOP".into());
        let refused = push_permitted(&guard, false).expect_err("push was allowed");
        assert!(refused.contains("DESKTOP"));
        // The take-over prompt is the user saying so out loud.
        assert!(push_permitted(&guard, true).is_ok());
    }

    /// LOCKALL (docs/satchels-and-sync.md 5.7): while another device has the
    /// Satchel, nothing in it may be created, renamed, moved or deleted —
    /// whether it was taken over mid-session or already held on arrival.
    #[test]
    fn nothing_is_editable_while_another_device_has_the_satchel() {
        let guard = StandDown::default();
        assert!(edits_permitted(&guard).is_ok(), "an unheld Satchel was read-only");

        guard.record("DESKTOP".into());
        let refused = edits_permitted(&guard).expect_err("a stood-down device edited");
        assert!(refused.starts_with(IN_USE_PREFIX), "unexpected refusal: {refused}");
        assert!(refused.contains("DESKTOP"), "the refusal doesn't name the holder");
        assert!(refused.contains(EDITING_PAUSED));
        // Wording rule, docs 5.5.
        assert!(!refused.to_lowercase().contains("conflict"));

        guard.clear();
        assert!(edits_permitted(&guard).is_ok(), "taking the Satchel back left it read-only");

        // The arrival case refuses identically...
        guard.record_on_arrival("LAPTOP".into());
        let refused = edits_permitted(&guard).expect_err("an arriving device edited");
        assert!(refused.starts_with(IN_USE_PREFIX), "unexpected refusal: {refused}");
        assert!(refused.contains("LAPTOP"));
        // ...but leaves the push path exactly as it was: arriving to a held
        // Satchel is the lease's refusal to make, and its wording is what offers
        // the user a take-over.
        assert_eq!(guard.taken_over_by(), None);
        let _permit = push_permitted(&guard, false).expect("arrival armed the push guard");
    }
}
