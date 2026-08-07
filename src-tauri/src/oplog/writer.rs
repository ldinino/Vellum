//! Appending to, and reading back, a notebook's change log.
//!
//! One file per device (`oplog/<device-id>.jsonl`), append-only. That shape is
//! chosen for sync: no two devices ever write the same file, so file sync has
//! nothing to conflict over and merging is concatenation.
//!
//! During the shadow period nothing reads these logs except the verifier, so a
//! write failure must never disturb the edit that produced it — see [`append`].

use std::io::Write;
use std::path::{Path, PathBuf};

use super::record::Record;

const DIR: &str = "oplog";

pub fn dir(notebook_dir: &Path) -> PathBuf {
    notebook_dir.join(DIR)
}

pub fn device_log(notebook_dir: &Path, device_id: &str) -> PathBuf {
    dir(notebook_dir).join(format!("{device_id}.jsonl"))
}

/// Append one record.
///
/// Opened and closed per call rather than held open: a long-lived handle on a
/// file inside the Satchel would block sync from replacing it, which is the
/// same mistake the SQLite WAL forced us to fix.
pub fn append(notebook_dir: &Path, device_id: &str, record: &Record) -> Result<(), String> {
    let path = device_log(notebook_dir, device_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut line =
        serde_json::to_string(record).map_err(|e| format!("serialize log record: {e}"))?;
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// Every record for a notebook, from all devices, in causal order.
///
/// A damaged line is skipped rather than fatal — a torn final write during a
/// crash must not make the rest of the history unreadable — and the count of
/// skipped lines is returned so the verifier can report it instead of silently
/// comparing against an incomplete log.
pub fn read_all(notebook_dir: &Path) -> Result<(Vec<Record>, usize), String> {
    let log_dir = dir(notebook_dir);
    let entries = match std::fs::read_dir(&log_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(format!("read {}: {e}", log_dir.display())),
    };

    let mut records = Vec::new();
    let mut damaged = 0usize;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Record>(line) {
                Ok(record) => records.push(record),
                Err(_) => damaged += 1,
            }
        }
    }

    records.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
    Ok((records, damaged))
}

#[cfg(test)]
mod tests {
    use super::super::clock::Timestamp;
    use super::super::record::Op;
    use super::*;

    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("vellum-oplog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn rec(dev: &str, ms: u64, id: &str) -> Record {
        Record::new(
            dev,
            Timestamp { wall_ms: ms, counter: 0 },
            Op::SectionDeleted { id: id.into() },
        )
    }

    #[test]
    fn appends_accumulate_and_read_back_in_order() {
        let dir = temp();
        append(&dir, "dev-a", &rec("dev-a", 3, "third")).unwrap();
        append(&dir, "dev-a", &rec("dev-a", 1, "first")).unwrap();
        append(&dir, "dev-b", &rec("dev-b", 2, "second")).unwrap();

        let (records, damaged) = read_all(&dir).unwrap();
        assert_eq!(damaged, 0);
        let ids: Vec<String> = records
            .iter()
            .map(|r| match &r.op {
                Op::SectionDeleted { id } => id.clone(),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(ids, vec!["first", "second", "third"], "logs merged out of order");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_log_is_empty_rather_than_an_error() {
        let dir = temp();
        assert_eq!(read_all(&dir).unwrap(), (Vec::new(), 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A crash can leave a half-written final line. Losing that one record is
    /// acceptable; losing the entire history because of it is not.
    #[test]
    fn a_torn_final_line_does_not_destroy_the_rest() {
        let dir = temp();
        append(&dir, "dev-a", &rec("dev-a", 1, "kept")).unwrap();
        let path = device_log(&dir, "dev-a");
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"v\":1,\"hlc\":\"000\",\"dev\"").unwrap();

        let (records, damaged) = read_all(&dir).unwrap();
        assert_eq!(records.len(), 1, "the intact record was lost");
        assert_eq!(damaged, 1, "the damaged line was not reported");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn each_device_writes_only_its_own_file() {
        let dir = temp();
        append(&dir, "dev-a", &rec("dev-a", 1, "a")).unwrap();
        append(&dir, "dev-b", &rec("dev-b", 1, "b")).unwrap();
        assert!(device_log(&dir, "dev-a").is_file());
        assert!(device_log(&dir, "dev-b").is_file());
        // No shared file means file sync has nothing to conflict over.
        let count = std::fs::read_dir(super::dir(&dir)).unwrap().count();
        assert_eq!(count, 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
