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
            assert!(!p.fields.is_empty(), "{} has no fields", p.id);
            assert!(!p.path_label.is_empty());
            for f in &p.fields {
                assert!(!f.key.is_empty());
                assert!(!f.label.is_empty());
            }
        }
    }

    #[test]
    fn every_provider_has_at_least_one_secret_field() {
        // A provider with no secret would mean credentials rendered in plain
        // text boxes and written to the log.
        for p in all() {
            assert!(
                p.fields.iter().any(|f| f.secret),
                "{} exposes all fields as plain text",
                p.id
            );
        }
    }

    #[test]
    fn lookup_by_id_matches_the_catalogue() {
        assert_eq!(by_id("b2").unwrap().backend, "b2");
        assert!(by_id("nope").is_none());
        assert_eq!(obscured_keys(&by_id("sftp").unwrap()), vec!["pass".to_string()]);
    }
}
