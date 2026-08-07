//! The sync remote attached to a Satchel.
//!
//! A remote is always two rclone remotes stacked: a `base` backend (S3, SFTP,
//! WebDAV, Drive…) and a `crypt` wrapper over it. Everything Vellum reads or
//! writes goes through the crypt layer, so filenames and contents are encrypted
//! before they leave the machine — there is no unencrypted option.
//!
//! The definition never becomes an `rclone.conf`. It is serialised, sealed with
//! DPAPI (see [`super::secrets`]), and written machine-locally; at invocation
//! time it is expanded into `RCLONE_CONFIG_*` environment variables.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::secrets;

/// rclone remote names for the two stacked layers. Internal detail — never
/// shown to the user.
const BASE: &str = "vellumbase";
const CRYPT: &str = "vellumcrypt";

/// Everything Vellum needs to reach a Satchel's remote storage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    /// rclone backend type, e.g. "s3", "sftp", "webdav", "drive".
    pub backend: String,
    /// Human label for the provider, e.g. "Backblaze B2". Shown in the UI; the
    /// backend type never is.
    pub label: String,
    /// Backend options, including credentials — `access_key_id`, `endpoint`,
    /// `host`, and so on. Ordered so the generated environment is stable.
    pub options: BTreeMap<String, String>,
    /// Path within the backend, e.g. "my-bucket/vellum".
    pub path: String,
    /// rclone-obscured crypt passwords. Losing these loses the data.
    pub crypt_password: String,
    pub crypt_password2: String,
}

impl RemoteConfig {
    /// The destination every sync command targets.
    pub fn target(&self) -> String {
        format!("{CRYPT}:")
    }

    /// Expand into `RCLONE_CONFIG_*` pairs. Secrets travel this way rather than
    /// in argv, which any process on the machine can read from the process list.
    pub fn env_vars(&self) -> Vec<(String, String)> {
        let mut env = vec![(
            format!("RCLONE_CONFIG_{}_TYPE", BASE.to_uppercase()),
            self.backend.clone(),
        )];
        for (key, value) in &self.options {
            env.push((
                format!("RCLONE_CONFIG_{}_{}", BASE.to_uppercase(), env_key(key)),
                value.clone(),
            ));
        }
        let crypt = CRYPT.to_uppercase();
        env.push((format!("RCLONE_CONFIG_{crypt}_TYPE"), "crypt".into()));
        env.push((
            format!("RCLONE_CONFIG_{crypt}_REMOTE"),
            format!("{BASE}:{}", self.path.trim_start_matches('/')),
        ));
        env.push((
            format!("RCLONE_CONFIG_{crypt}_PASSWORD"),
            self.crypt_password.clone(),
        ));
        env.push((
            format!("RCLONE_CONFIG_{crypt}_PASSWORD2"),
            self.crypt_password2.clone(),
        ));
        env
    }
}

/// rclone reads option names case-insensitively but the environment form is
/// uppercase with non-alphanumerics folded to underscores.
fn env_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect()
}

/// A fresh pair of crypt passwords, already obscured for rclone.
///
/// Entropy comes from two v4 UUIDs (~244 bits) rather than a new RNG
/// dependency. These are never shown to the user or typed by hand — they travel
/// only inside the connection code — so length costs nothing.
pub fn generate_crypt_passwords() -> Result<(String, String), String> {
    let raw1 = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let raw2 = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    Ok((super::rclone::obscure(&raw1)?, super::rclone::obscure(&raw2)?))
}

/// Where a Satchel's sealed remote definition lives. `dir` is the machine-local
/// `%LOCALAPPDATA%\Vellum` — never a Satchel folder, which would sync it.
pub fn store_path(dir: &Path, satchel_id: &str) -> PathBuf {
    dir.join("remotes").join(format!("{satchel_id}.remote"))
}

pub fn save(dir: &Path, satchel_id: &str, config: &RemoteConfig) -> Result<(), String> {
    let json = serde_json::to_vec(config).map_err(|e| format!("serialize remote: {e}"))?;
    let sealed = secrets::protect(&json)?;
    let path = store_path(dir, satchel_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Same temp-then-rename as the JSON config writers, so a crash mid-write
    // can't leave a half-sealed blob that would strand the remote.
    let tmp = path.with_extension("remote.tmp");
    std::fs::write(&tmp, &sealed).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {}: {e}", path.display())
    })
}

/// `None` when the Satchel simply isn't synced; `Err` when a definition exists
/// but can't be read (wrong user or machine), which the user must be told about
/// rather than silently treated as "not synced".
pub fn load(dir: &Path, satchel_id: &str) -> Result<Option<RemoteConfig>, String> {
    let path = store_path(dir, satchel_id);
    let sealed = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let json = secrets::unprotect(&sealed)?;
    serde_json::from_slice(&json)
        .map(Some)
        .map_err(|e| format!("the saved sync settings are unreadable: {e}"))
}

/// Forget a Satchel's remote. Deletes nothing on the storage provider.
pub fn delete(dir: &Path, satchel_id: &str) -> Result<(), String> {
    let path = store_path(dir, satchel_id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RemoteConfig {
        let mut options = BTreeMap::new();
        options.insert("access_key_id".to_string(), "AKIA".to_string());
        options.insert("secret_access_key".to_string(), "hunter2".to_string());
        RemoteConfig {
            backend: "s3".into(),
            label: "Backblaze B2".into(),
            options,
            path: "my-bucket/vellum".into(),
            crypt_password: "obscured1".into(),
            crypt_password2: "obscured2".into(),
        }
    }

    #[test]
    fn env_vars_stack_crypt_over_the_base_backend() {
        let env: BTreeMap<String, String> = sample().env_vars().into_iter().collect();
        assert_eq!(env["RCLONE_CONFIG_VELLUMBASE_TYPE"], "s3");
        assert_eq!(env["RCLONE_CONFIG_VELLUMBASE_ACCESS_KEY_ID"], "AKIA");
        assert_eq!(env["RCLONE_CONFIG_VELLUMCRYPT_TYPE"], "crypt");
        assert_eq!(
            env["RCLONE_CONFIG_VELLUMCRYPT_REMOTE"],
            "vellumbase:my-bucket/vellum"
        );
        assert_eq!(env["RCLONE_CONFIG_VELLUMCRYPT_PASSWORD"], "obscured1");
        assert_eq!(sample().target(), "vellumcrypt:");
    }

    #[test]
    fn env_key_folds_separators() {
        assert_eq!(env_key("access-key.id"), "ACCESS_KEY_ID");
    }

    #[cfg(windows)]
    #[test]
    fn saved_definition_round_trips_and_is_not_readable_as_plaintext() {
        let dir = std::env::temp_dir().join(format!("vellum-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(load(&dir, "sat").unwrap(), None, "absent means not synced");

        let config = sample();
        save(&dir, "sat", &config).unwrap();
        assert_eq!(load(&dir, "sat").unwrap().unwrap(), config);

        let raw = std::fs::read(store_path(&dir, "sat")).unwrap();
        assert!(
            raw.windows(7).all(|w| w != b"hunter2"),
            "the secret is sitting in the file in the clear"
        );

        delete(&dir, "sat").unwrap();
        assert_eq!(load(&dir, "sat").unwrap(), None);
        delete(&dir, "sat").unwrap(); // deleting twice is not an error

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The generated environment has to actually drive rclone — a unit test on
    /// the strings alone would not catch a wrong variable name. Uses the `local`
    /// backend so no credentials or network are needed.
    #[test]
    fn generated_env_actually_works_against_rclone() {
        if super::super::rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let dir = std::env::temp_dir().join(format!("vellum-remote-e2e-{}", uuid::Uuid::new_v4()));
        let store = dir.join("store");
        std::fs::create_dir_all(&store).unwrap();

        let (p1, p2) = generate_crypt_passwords().unwrap();
        let config = RemoteConfig {
            backend: "local".into(),
            label: "Local folder".into(),
            options: BTreeMap::new(),
            path: store.to_string_lossy().into_owned(),
            crypt_password: p1,
            crypt_password2: p2,
        };

        super::super::rclone::probe(&config.env_vars(), &config.target())
            .expect("probe should succeed through the generated environment");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
