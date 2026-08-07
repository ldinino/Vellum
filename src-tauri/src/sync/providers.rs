//! The curated provider list.
//!
//! rclone supports ~70 backends. Showing that list is exactly the experience
//! this feature exists to avoid, so Vellum offers a short set of tiles and
//! decides everything else — the crypt wrapper, the remote names, the transfer
//! flags — on the user's behalf.
//!
//! Each provider declares the fields its form needs, so the UI renders one
//! generic form rather than a bespoke screen per provider, and adding a backend
//! is a data change.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// rclone option name, e.g. "access_key_id".
    pub key: String,
    pub label: String,
    pub hint: String,
    /// Rendered as a password box and never logged.
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub label: String,
    /// rclone backend type. An implementation detail — never shown.
    pub backend: String,
    pub fields: Vec<Field>,
    /// Options the user never sees or chooses.
    pub fixed: BTreeMap<String, String>,
    /// What the "where to put it" box is called for this backend.
    pub path_label: String,
    pub path_hint: String,
    /// Signed in through the browser rather than by typing credentials, so the
    /// form is a Connect button instead of a set of fields.
    pub oauth: bool,
}

fn field(key: &str, label: &str, hint: &str, secret: bool) -> Field {
    Field {
        key: key.into(),
        label: label.into(),
        hint: hint.into(),
        secret,
    }
}

/// Every provider Vellum offers, in the order the tiles appear.
pub fn all() -> Vec<Provider> {
    vec![
        Provider {
            id: "drive".into(),
            label: "Google Drive".into(),
            backend: "drive".into(),
            fields: Vec::new(),
            // Confine Vellum to files it created. A note-sync tool has no
            // business holding read/write access to someone's whole Drive.
            fixed: BTreeMap::from([("scope".to_string(), "drive.file".to_string())]),
            path_label: "Folder".into(),
            path_hint: "A folder in your Drive, e.g. Vellum. It is created if missing.".into(),
            oauth: true,
        },
        Provider {
            id: "dropbox".into(),
            label: "Dropbox".into(),
            backend: "dropbox".into(),
            fields: Vec::new(),
            fixed: BTreeMap::new(),
            path_label: "Folder".into(),
            path_hint: "A folder in your Dropbox, e.g. Vellum. It is created if missing.".into(),
            oauth: true,
        },
        Provider {
            id: "local".into(),
            label: "Folder or network drive".into(),
            backend: "local".into(),
            // A path is all the local backend needs; there is nothing to
            // authenticate against.
            fields: Vec::new(),
            fixed: BTreeMap::new(),
            path_label: "Folder".into(),
            path_hint: "A mapped drive, NAS share or removable disk, e.g. \\\\nas\\vellum. Contents are still encrypted.".into(),
            oauth: false,
        },
        Provider {
            id: "b2".into(),
            label: "Backblaze B2".into(),
            backend: "b2".into(),
            fields: vec![
                field("account", "Key ID", "From Application Keys in your B2 account", false),
                field("key", "Application key", "Shown once when you create the key", true),
            ],
            fixed: BTreeMap::new(),
            path_label: "Bucket".into(),
            path_hint: "An existing bucket, optionally with a folder: my-bucket/vellum".into(),
            oauth: false,
        },
        Provider {
            id: "s3".into(),
            label: "S3-compatible storage".into(),
            backend: "s3".into(),
            fields: vec![
                field("endpoint", "Endpoint", "e.g. s3.us-west-002.backblazeb2.com", false),
                field("access_key_id", "Access key ID", "", false),
                field("secret_access_key", "Secret access key", "", true),
                field("region", "Region", "Leave blank if your provider has none", false),
            ],
            fixed: BTreeMap::from([("provider".to_string(), "Other".to_string())]),
            path_label: "Bucket".into(),
            path_hint: "An existing bucket, optionally with a folder: my-bucket/vellum".into(),
            oauth: false,
        },
        Provider {
            id: "sftp".into(),
            label: "SFTP server".into(),
            backend: "sftp".into(),
            fields: vec![
                field("host", "Host", "e.g. files.example.com", false),
                field("user", "Username", "", false),
                field("pass", "Password", "", true),
                field("port", "Port", "Leave blank for 22", false),
            ],
            fixed: BTreeMap::new(),
            path_label: "Folder".into(),
            path_hint: "Path on the server, e.g. /home/me/vellum".into(),
            oauth: false,
        },
        Provider {
            id: "webdav".into(),
            label: "WebDAV (Nextcloud, ownCloud)".into(),
            backend: "webdav".into(),
            fields: vec![
                field("url", "Server URL", "e.g. https://cloud.example.com/remote.php/dav/files/me", false),
                field("user", "Username", "", false),
                field("pass", "Password", "An app password, if your server offers them", true),
            ],
            fixed: BTreeMap::from([("vendor".to_string(), "other".to_string())]),
            path_label: "Folder".into(),
            path_hint: "Folder on the server, e.g. vellum".into(),
            oauth: false,
        },
    ]
}

pub fn by_id(id: &str) -> Option<Provider> {
    all().into_iter().find(|p| p.id == id)
}

/// rclone stores passwords in its own obscured form; plain values are rejected
/// by some backends and silently mishandled by others.
pub fn obscured_keys(provider: &Provider) -> Vec<String> {
    provider
        .fields
        .iter()
        .filter(|f| f.secret)
        .map(|f| f.key.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_well_formed() {
        let providers = all();
        assert!(!providers.is_empty());
        let mut ids = std::collections::HashSet::new();
        for p in &providers {
            assert!(ids.insert(p.id.clone()), "duplicate provider id {}", p.id);
            assert!(!p.label.is_empty());
            assert!(!p.backend.is_empty());
            assert!(!p.path_label.is_empty());
            for f in &p.fields {
                assert!(!f.key.is_empty());
                assert!(!f.label.is_empty());
            }
        }
    }

    /// A credential rendered in a plain text box is also a credential written to
    /// the log, so anything that looks like one must be marked secret. Providers
    /// with nothing to authenticate against (a local folder) are exempt.
    #[test]
    fn credential_fields_are_always_marked_secret() {
        for p in all() {
            for f in &p.fields {
                let looks_secret = ["pass", "secret", "key", "token"]
                    .iter()
                    .any(|needle| f.key.contains(needle));
                // "access_key_id" is a public identifier, not a credential.
                if looks_secret && f.key != "access_key_id" {
                    assert!(f.secret, "{}.{} carries a credential in plain text", p.id, f.key);
                }
            }
        }
    }

    #[test]
    fn lookup_by_id_matches_the_catalogue() {
        assert_eq!(by_id("b2").unwrap().backend, "b2");
        assert!(by_id("nope").is_none());
        assert_eq!(obscured_keys(&by_id("sftp").unwrap()), vec!["pass".to_string()]);
    }
}
