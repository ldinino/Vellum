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
