//! Stable per-machine identity.
//!
//! Sync needs to answer "is the other device still holding the lease, or is
//! that me?" across restarts, so the id has to outlive the process and must be
//! machine-local — it deliberately does not live in a Satchel, or every device
//! sharing that Satchel would claim the same identity.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    /// Shown in "In use by LAPTOP since 09:12", so it has to mean something to
    /// a person. Defaults to the machine name.
    pub name: String,
}

fn path(dir: &Path) -> PathBuf {
    dir.join("device.json")
}

/// Read this machine's identity, creating it on first call.
pub fn get_or_create(dir: &Path) -> Result<Device, String> {
    let p = path(dir);
    if let Ok(text) = std::fs::read_to_string(&p) {
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        if let Ok(device) = serde_json::from_str::<Device>(text) {
            if !device.id.is_empty() {
                return Ok(device);
            }
        }
    }
    let device = Device {
        id: uuid::Uuid::new_v4().to_string(),
        name: machine_name(),
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(&device).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&p, json).map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(device)
}

fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "This device".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_created_once_and_then_stable() {
        let dir = std::env::temp_dir().join(format!("vellum-device-{}", uuid::Uuid::new_v4()));
        let first = get_or_create(&dir).unwrap();
        let second = get_or_create(&dir).unwrap();
        assert_eq!(first, second, "the id must survive a restart");
        assert!(!first.id.is_empty());
        assert!(!first.name.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_replaced_rather_than_fatal() {
        let dir = std::env::temp_dir().join(format!("vellum-device-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), b"not json").unwrap();
        assert!(!get_or_create(&dir).unwrap().id.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
