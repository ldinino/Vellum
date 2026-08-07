//! Single-writer lease over a Satchel's remote.
//!
//! Scope is the whole Satchel, matching the sync payload: `app.json` travels
//! with it, so two devices writing at once would conflict on settings as well
//! as notebooks.
//!
//! **The lease is advisory, and deliberately so.** Object stores offer no
//! compare-and-swap we can rely on across every backend, so this cannot be a
//! true mutual exclusion primitive — a device that is offline can still edit.
//! What it buys is that the common case (two machines used in turn) stops being
//! a conflict at all, and the uncommon case is detected rather than silently
//! merged. Phase B's oplog is what actually makes concurrent editing safe.

use serde::{Deserialize, Serialize};

use super::device::Device;
use super::rclone;

const LEASE_FILE: &str = "lease.json";

/// How long a lease survives without a heartbeat before another device may take
/// it. Long enough to ride out a sleep or a slow network, short enough that a
/// crashed device doesn't lock you out for the rest of the day.
pub const STALE_AFTER_SECS: i64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub device_id: String,
    pub device_name: String,
    /// RFC 3339.
    pub acquired_at: String,
    pub heartbeat_at: String,
}

impl Lease {
    /// Seconds since the last heartbeat, or `None` if the timestamp is
    /// unparseable — treated by callers as "assume it is live", because
    /// stealing a lease we don't understand is the more destructive mistake.
    pub fn age_secs(&self, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
        let beat = chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at).ok()?;
        Some((now - beat.with_timezone(&chrono::Utc)).num_seconds())
    }

    pub fn is_stale(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.age_secs(now).is_some_and(|age| age > STALE_AFTER_SECS)
    }
}

/// What the caller should do about the current holder.
#[derive(Debug, Clone, PartialEq)]
pub enum LeaseState {
    /// Nobody holds it, it is ours already, or the holder went stale.
    Available(Option<Lease>),
    /// Another device is actively using this Satchel.
    Held(Lease),
}

/// Read the current lease, if any.
pub fn read(env: &[(String, String)], target: &str) -> Result<Option<Lease>, String> {
    let path = format!("{}{LEASE_FILE}", normalise(target));
    // A missing lease is the normal case, not an error — distinguish it from a
    // real failure by asking whether anything is there first.
    let listing = rclone::run(env, &["lsf", target])?;
    if !listing.stdout.lines().any(|l| l.trim() == LEASE_FILE) {
        return Ok(None);
    }
    let out = rclone::run(env, &["cat", &path])?;
    serde_json::from_str(&out.stdout)
        .map(Some)
        .map_err(|_| "The lock file on the storage is unreadable.".to_string())
}

pub fn state(
    env: &[(String, String)],
    target: &str,
    me: &Device,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<LeaseState, String> {
    Ok(match read(env, target)? {
        None => LeaseState::Available(None),
        Some(lease) if lease.device_id == me.id => LeaseState::Available(Some(lease)),
        Some(lease) if lease.is_stale(now) => LeaseState::Available(Some(lease)),
        Some(lease) => LeaseState::Held(lease),
    })
}

/// Claim the lease, overwriting whatever is there. Callers must have checked
/// [`state`] first and, when it was `Held`, obtained the user's explicit
/// agreement to take over.
pub fn acquire(
    env: &[(String, String)],
    target: &str,
    me: &Device,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Lease, String> {
    let lease = Lease {
        device_id: me.id.clone(),
        device_name: me.name.clone(),
        acquired_at: now.to_rfc3339(),
        heartbeat_at: now.to_rfc3339(),
    };
    write(env, target, &lease)?;

    // No object store we support offers a CAS we can rely on, so confirm by
    // reading back: if two devices raced, the loser finds someone else's id and
    // backs off rather than both believing they hold it.
    match read(env, target)? {
        Some(current) if current.device_id == me.id => Ok(lease),
        Some(other) => Err(format!(
            "{} claimed this Satchel at the same moment. Try again.",
            other.device_name
        )),
        None => Err("The lock could not be written to the storage.".into()),
    }
}

/// Refresh our heartbeat. Returns `false` if someone else now holds the lease,
/// which means we were taken over and must stop writing.
pub fn heartbeat(
    env: &[(String, String)],
    target: &str,
    me: &Device,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<bool, String> {
    let Some(current) = read(env, target)? else {
        return Ok(false);
    };
    if current.device_id != me.id {
        return Ok(false);
    }
    write(
        env,
        target,
        &Lease { heartbeat_at: now.to_rfc3339(), ..current },
    )?;
    Ok(true)
}

/// Give up the lease. Never removes another device's lease.
pub fn release(env: &[(String, String)], target: &str, me: &Device) -> Result<(), String> {
    match read(env, target)? {
        Some(current) if current.device_id == me.id => {
            let path = format!("{}{LEASE_FILE}", normalise(target));
            rclone::run(env, &["deletefile", &path]).map(|_| ())
        }
        _ => Ok(()),
    }
}

fn write(env: &[(String, String)], target: &str, lease: &Lease) -> Result<(), String> {
    let json = serde_json::to_string_pretty(lease).map_err(|e| format!("serialize lease: {e}"))?;
    // rcat takes the body on stdin, which keeps the lease off the local disk
    // and out of argv.
    rclone::run_with_stdin(env, &["rcat", &format!("{}{LEASE_FILE}", normalise(target))], &json)
        .map(|_| ())
}

/// rclone targets are either `remote:` or `remote:path`; make sure exactly one
/// separator ends up before the filename.
fn normalise(target: &str) -> String {
    if target.ends_with(':') || target.ends_with('/') {
        target.to_string()
    } else {
        format!("{target}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    fn device(name: &str) -> Device {
        Device { id: format!("id-{name}"), name: name.to_string() }
    }

    /// A crypt-wrapped local folder, so the lease is exercised through exactly
    /// the same stack real sync uses.
    fn local_remote(dir: &std::path::Path) -> (Vec<(String, String)>, String) {
        let config = super::super::remote::RemoteConfig {
            backend: "local".into(),
            label: "Local".into(),
            options: BTreeMap::new(),
            path: dir.to_string_lossy().into_owned(),
            crypt_password: super::super::rclone::obscure("p1").unwrap(),
            crypt_password2: super::super::rclone::obscure("p2").unwrap(),
        };
        (config.env_vars(), config.target())
    }

    #[test]
    fn staleness_is_measured_from_the_heartbeat() {
        let base = now();
        let mut lease = Lease {
            device_id: "a".into(),
            device_name: "A".into(),
            acquired_at: base.to_rfc3339(),
            heartbeat_at: base.to_rfc3339(),
        };
        assert!(!lease.is_stale(base));
        assert!(!lease.is_stale(base + chrono::Duration::seconds(STALE_AFTER_SECS - 1)));
        assert!(lease.is_stale(base + chrono::Duration::seconds(STALE_AFTER_SECS + 1)));

        lease.heartbeat_at = "not a timestamp".into();
        assert!(
            !lease.is_stale(base),
            "an unparseable heartbeat must be treated as live, not stolen"
        );
    }

    #[test]
    fn acquire_heartbeat_and_release_round_trip() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let dir = std::env::temp_dir().join(format!("vellum-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (env, target) = local_remote(&dir);
        let me = device("LAPTOP");

        assert_eq!(read(&env, &target).unwrap(), None);
        assert_eq!(state(&env, &target, &me, now()).unwrap(), LeaseState::Available(None));

        let lease = acquire(&env, &target, &me, now()).unwrap();
        assert_eq!(lease.device_id, me.id);
        assert_eq!(read(&env, &target).unwrap().unwrap().device_name, "LAPTOP");

        // Our own lease never blocks us.
        assert!(matches!(
            state(&env, &target, &me, now()).unwrap(),
            LeaseState::Available(Some(_))
        ));

        assert!(heartbeat(&env, &target, &me, now()).unwrap());

        release(&env, &target, &me).unwrap();
        assert_eq!(read(&env, &target).unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_devices_live_lease_blocks_but_a_stale_one_does_not() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let dir = std::env::temp_dir().join(format!("vellum-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (env, target) = local_remote(&dir);
        let desktop = device("DESKTOP");
        let laptop = device("LAPTOP");

        acquire(&env, &target, &desktop, now()).unwrap();
        match state(&env, &target, &laptop, now()).unwrap() {
            LeaseState::Held(l) => assert_eq!(l.device_name, "DESKTOP"),
            other => panic!("expected Held, got {other:?}"),
        }

        // Far enough in the future that DESKTOP's heartbeat has gone stale.
        let later = now() + chrono::Duration::seconds(STALE_AFTER_SECS + 60);
        assert!(matches!(
            state(&env, &target, &laptop, later).unwrap(),
            LeaseState::Available(Some(_))
        ));

        // A device must never delete someone else's lease.
        release(&env, &target, &laptop).unwrap();
        assert_eq!(
            read(&env, &target).unwrap().unwrap().device_name,
            "DESKTOP",
            "release removed another device's lease"
        );

        // Nor should a heartbeat succeed once taken over.
        acquire(&env, &target, &laptop, later).unwrap();
        assert!(!heartbeat(&env, &target, &desktop, later).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
