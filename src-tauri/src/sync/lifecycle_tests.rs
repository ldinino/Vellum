//! Two-device simulation of the whole phase A lifecycle.
//!
//! The unit tests each cover one piece; this drives the pieces together in the
//! order real use hits them — set up on device 1, pair device 2 with a
//! connection code, hand the Satchel back and forth, then force a conflict —
//! against the real rclone binary through a crypt-wrapped folder.
//!
//! It exists because the orchestration layer needs an `AppHandle` and so can't
//! be tested directly; this exercises the same sequence that layer performs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{code, device::Device, engine, lease, rclone, remote::RemoteConfig};

fn temp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("vellum-e2e-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn device(name: &str) -> Device {
    Device { id: format!("id-{name}"), name: name.to_string() }
}

/// A Satchel the way the app lays one out.
async fn make_satchel(dir: &Path, note: &[u8]) {
    std::fs::create_dir_all(dir.join("nb")).unwrap();
    std::fs::write(dir.join("app.json"), b"{\"settings\":{}}").unwrap();
    std::fs::write(dir.join("notebooks.json"), b"{\"notebooks\":[]}").unwrap();
    crate::db::create_or_migrate(&dir.join("nb").join("notebook.db"))
        .await
        .unwrap();
    std::fs::write(dir.join("nb").join("page.txt"), note).unwrap();
}

fn skip() -> bool {
    if rclone::binary_path().is_err() {
        eprintln!("skipping: rclone sidecar not fetched");
        return true;
    }
    false
}

#[tokio::test]
async fn two_devices_share_a_satchel_through_a_connection_code() {
    if skip() {
        return;
    }
    let store = temp("store");
    let one = temp("device1");
    let two = temp("device2");
    make_satchel(&one, b"written on device one").await;

    // --- device 1 sets sync up -------------------------------------------
    let (p1, p2) = super::remote::generate_crypt_passwords().unwrap();
    let config = RemoteConfig {
        backend: "local".into(),
        label: "Folder or network drive".into(),
        options: BTreeMap::new(),
        path: store.to_string_lossy().into_owned(),
        crypt_password: p1,
        crypt_password2: p2,
    };
    let env = config.env_vars();
    let target = config.target();
    rclone::probe(&env, &target).expect("a fresh remote must pass the connection test");

    let laptop = device("LAPTOP");
    lease::acquire(&env, &target, &laptop, chrono::Utc::now()).unwrap();
    let outcome = engine::push(&env, &target, &one, 0, &laptop).await.unwrap();
    let gen1 = match outcome {
        engine::SyncOutcome::Completed { state, .. } => state.generation,
        other => panic!("expected Completed, got {other:?}"),
    };
    lease::release(&env, &target, &laptop).unwrap();

    // Nothing readable is sitting in the storage folder.
    let stored: Vec<String> = std::fs::read_dir(&store)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!stored.is_empty(), "nothing was uploaded");
    assert!(
        !stored.iter().any(|n| n == "app.json" || n == "nb"),
        "filenames reached the storage unencrypted: {stored:?}"
    );

    // --- device 2 pairs from the code ------------------------------------
    let text = code::encode(&config, "shared-passphrase").unwrap();
    let adopted = code::decode(&text, "shared-passphrase").unwrap();
    assert_eq!(adopted, config, "the code must reproduce the remote exactly");

    let desktop = device("DESKTOP");
    let env2 = adopted.env_vars();
    let target2 = adopted.target();
    lease::acquire(&env2, &target2, &desktop, chrono::Utc::now()).unwrap();
    let pulled = engine::pull(&env2, &target2, &two).unwrap();
    assert_eq!(pulled.generation, gen1);
    assert_eq!(
        std::fs::read(two.join("nb").join("page.txt")).unwrap(),
        b"written on device one",
        "device 2 did not receive device 1's work"
    );
    assert!(two.join("nb").join("notebook.db").is_file());

    // --- device 2 edits and pushes back ----------------------------------
    std::fs::write(two.join("nb").join("page.txt"), b"edited on device two").unwrap();
    let outcome = engine::push(&env2, &target2, &two, gen1, &desktop).await.unwrap();
    let gen2 = match outcome {
        engine::SyncOutcome::Completed { state, .. } => state.generation,
        other => panic!("expected Completed, got {other:?}"),
    };
    assert!(gen2 > gen1);
    lease::release(&env2, &target2, &desktop).unwrap();

    // --- device 1 picks the changes up -----------------------------------
    let pulled = engine::pull(&env, &target, &one).unwrap();
    assert_eq!(pulled.generation, gen2);
    assert_eq!(
        std::fs::read(one.join("nb").join("page.txt")).unwrap(),
        b"edited on device two",
        "device 1 did not receive device 2's work"
    );

    for d in [store, one, two] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[tokio::test]
async fn a_device_that_edited_offline_keeps_its_work_when_the_remote_moved_on() {
    if skip() {
        return;
    }
    let store = temp("conflict-store");
    let one = temp("conflict-one");
    let two = temp("conflict-two");
    make_satchel(&one, b"device one original").await;

    let (p1, p2) = super::remote::generate_crypt_passwords().unwrap();
    let config = RemoteConfig {
        backend: "local".into(),
        label: "Folder or network drive".into(),
        options: BTreeMap::new(),
        path: store.to_string_lossy().into_owned(),
        crypt_password: p1,
        crypt_password2: p2,
    };
    let env = config.env_vars();
    let target = config.target();

    let laptop = device("LAPTOP");
    let desktop = device("DESKTOP");
    let gen1 = match engine::push(&env, &target, &one, 0, &laptop).await.unwrap() {
        engine::SyncOutcome::Completed { state, .. } => state.generation,
        other => panic!("{other:?}"),
    };

    // DESKTOP syncs, edits, and pushes.
    engine::pull(&env, &target, &two).unwrap();
    std::fs::write(two.join("nb").join("page.txt"), b"desktop wins the race").unwrap();
    engine::push(&env, &target, &two, gen1, &desktop).await.unwrap();

    // LAPTOP edited offline and still believes the remote is at gen1.
    std::fs::write(one.join("nb").join("page.txt"), b"laptop worked offline").unwrap();
    let outcome = engine::push(&env, &target, &one, gen1, &laptop).await.unwrap();
    assert!(
        matches!(outcome, engine::SyncOutcome::Conflict { .. }),
        "the push should have been refused, got {outcome:?}"
    );

    // The remote still holds DESKTOP's version...
    let check = temp("conflict-check");
    engine::pull(&env, &target, &check).unwrap();
    assert_eq!(
        std::fs::read(check.join("nb").join("page.txt")).unwrap(),
        b"desktop wins the race"
    );

    // ...and LAPTOP's offline work survives in a copy it can open.
    let copy = engine::preserve_conflict_copy(&one, &laptop.name, chrono::Local::now()).unwrap();
    assert_eq!(
        std::fs::read(copy.join("nb").join("page.txt")).unwrap(),
        b"laptop worked offline",
        "the offline work was lost"
    );
    assert!(copy.join("nb").join("notebook.db").is_file());

    for d in [store, one, two, check] {
        let _ = std::fs::remove_dir_all(d);
    }
    let _ = std::fs::remove_dir_all(copy);
}

/// The lease is what keeps the common case (two machines used in turn) from
/// ever becoming a conflict, so the hand-off has to work through the real stack.
#[tokio::test]
async fn the_satchel_is_handed_over_cleanly_between_devices() {
    if skip() {
        return;
    }
    let store = temp("lease-store");
    let (p1, p2) = super::remote::generate_crypt_passwords().unwrap();
    let config = RemoteConfig {
        backend: "local".into(),
        label: "Folder or network drive".into(),
        options: BTreeMap::new(),
        path: store.to_string_lossy().into_owned(),
        crypt_password: p1,
        crypt_password2: p2,
    };
    let env = config.env_vars();
    let target = config.target();
    let laptop = device("LAPTOP");
    let desktop = device("DESKTOP");
    let now = chrono::Utc::now();

    lease::acquire(&env, &target, &laptop, now).unwrap();
    assert!(
        matches!(
            lease::state(&env, &target, &desktop, now).unwrap(),
            lease::LeaseState::Held(_)
        ),
        "DESKTOP should be blocked while LAPTOP holds it"
    );

    // Clean exit hands it back immediately rather than waiting for staleness.
    lease::release(&env, &target, &laptop).unwrap();
    assert_eq!(
        lease::state(&env, &target, &desktop, now).unwrap(),
        lease::LeaseState::Available(None),
        "the Satchel was not released on exit"
    );
    lease::acquire(&env, &target, &desktop, now).unwrap();

    let _ = std::fs::remove_dir_all(store);
}

/// STANDDOWN (docs/satchels-and-sync.md 5.1): once another device takes the
/// Satchel, this one must find out on its heartbeat and never push again.
///
/// Driven through the real rclone stack so the whole chain is exercised —
/// take-over, heartbeat, guard, refused push — rather than the guard alone.
#[tokio::test]
async fn a_taken_over_device_stands_down_and_cannot_push() {
    if skip() {
        return;
    }
    let store = temp("standdown-store");
    let one = temp("standdown-device1");
    make_satchel(&one, b"typed just before the take-over").await;

    let (p1, p2) = super::remote::generate_crypt_passwords().unwrap();
    let config = RemoteConfig {
        backend: "local".into(),
        label: "Folder or network drive".into(),
        options: BTreeMap::new(),
        path: store.to_string_lossy().into_owned(),
        crypt_password: p1,
        crypt_password2: p2,
    };
    let env = config.env_vars();
    let target = config.target();
    let laptop = device("LAPTOP");
    let desktop = device("DESKTOP");
    let now = chrono::Utc::now();
    let guard = super::StandDown::default();

    // LAPTOP is the open window; its heartbeats are unremarkable.
    lease::acquire(&env, &target, &laptop, now).unwrap();
    let standing = lease::heartbeat(&env, &target, &laptop, now).unwrap();
    let outcome = super::standing_outcome(standing, &guard);
    assert!(outcome.held && outcome.taken_over_by.is_none());
    assert_eq!(guard.taken_over_by(), None);
    let _permit = super::push_permitted(&guard, false)
        .expect("a device holding the lease must be able to push");

    // DESKTOP takes over, as the existing take-over path does.
    lease::acquire(&env, &target, &desktop, now).unwrap();

    // LAPTOP's next heartbeat is where it finds out.
    let standing = lease::heartbeat(&env, &target, &laptop, now).unwrap();
    let outcome = super::standing_outcome(standing, &guard);
    assert!(!outcome.held);
    assert_eq!(
        outcome.taken_over_by.as_deref(),
        Some("DESKTOP"),
        "the window must be able to name who took it"
    );
    assert_eq!(guard.taken_over_by().as_deref(), Some("DESKTOP"));

    // The close-time push is the dangerous one: it asks for no take-over and
    // would otherwise write over DESKTOP's work.
    let refused = super::push_permitted(&guard, false).expect_err("a stood-down device pushed");
    assert!(
        refused.contains("DESKTOP"),
        "the refusal must say who has it, got {refused:?}"
    );

    // And the work typed before the take-over is preservable the same way a
    // losing pull preserves it.
    let copy = engine::preserve_conflict_copy(&one, &laptop.name, chrono::Local::now()).unwrap();
    assert_eq!(
        std::fs::read(copy.join("nb").join("page.txt")).unwrap(),
        b"typed just before the take-over",
        "the unsynced work was lost"
    );

    // Taking it back is explicit, and only then does pushing become possible.
    lease::acquire(&env, &target, &laptop, now).unwrap();
    guard.clear();
    let _permit = super::push_permitted(&guard, false)
        .expect("after taking the Satchel back, pushing must work again");

    for d in [store, one, copy] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// SILENTHOLD severity: what an instance that was refused the Satchel on
/// arrival can still do to the remote on its way out.
///
/// It never acquired the lease and STANDDOWN was never armed, so the push
/// guard does not apply to it. Two things have to hold instead: the live
/// holder blocks the push outright, and once the holder has gone the stale
/// generation blocks it as a conflict rather than overwriting the work.
#[tokio::test]
async fn an_instance_refused_on_arrival_cannot_overwrite_the_holder() {
    if skip() {
        return;
    }
    let store = temp("silenthold-store");
    let one = temp("silenthold-one");
    let two = temp("silenthold-two");
    make_satchel(&one, b"the holder is still writing").await;
    make_satchel(&two, b"stale, never pulled").await;

    let (p1, p2) = super::remote::generate_crypt_passwords().unwrap();
    let config = RemoteConfig {
        backend: "local".into(),
        label: "Folder or network drive".into(),
        options: BTreeMap::new(),
        path: store.to_string_lossy().into_owned(),
        crypt_password: p1,
        crypt_password2: p2,
    };
    let env = config.env_vars();
    let target = config.target();

    let holder = device("DESKTOP");
    let arriving = device("LAPTOP");
    let now = chrono::Utc::now();

    // The holder has the Satchel and has pushed it.
    lease::acquire(&env, &target, &holder, now).unwrap();
    engine::push(&env, &target, &one, 0, &holder).await.unwrap();

    // The arriving instance is refused its opening pull, so its generation
    // stays where it was: it has no idea the remote moved.
    let state = lease::state(&env, &target, &arriving, now).unwrap();
    let refused = super::refuse_if_held(&state, "It hasn't been updated from your storage.")
        .expect_err("the opening pull must be refused while another device holds it");
    assert!(refused.starts_with(super::IN_USE_PREFIX), "unexpected refusal: {refused}");

    // The push it runs on close goes through the same rule, so while the
    // holder is live nothing leaves this machine.
    let state = lease::state(&env, &target, &arriving, now).unwrap();
    super::refuse_if_held(&state, "Syncing now would risk losing the changes made there.")
        .expect_err("the closing push must be refused too");

    // The holder finishes and lets go. Now the lease says nothing, and only
    // the generation stands between the stale instance and the work.
    lease::release(&env, &target, &holder).unwrap();
    let state = lease::state(&env, &target, &arriving, chrono::Utc::now()).unwrap();
    super::refuse_if_held(&state, "x").expect("a released lease no longer refuses");
    let outcome = engine::push(&env, &target, &two, 0, &arriving).await.unwrap();
    assert!(
        matches!(outcome, engine::SyncOutcome::Conflict { local: 0, remote: 1 }),
        "the stale instance overwrote the remote: {outcome:?}"
    );

    let check = temp("silenthold-check");
    engine::pull(&env, &target, &check).unwrap();
    assert_eq!(
        std::fs::read(check.join("nb").join("page.txt")).unwrap(),
        b"the holder is still writing",
        "the holder's work was overwritten"
    );

    for d in [store, one, two, check] {
        let _ = std::fs::remove_dir_all(d);
    }
}
