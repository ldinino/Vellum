//! App-wide diagnostic log (Phase 11).
//!
//! A bounded in-memory ring buffer of structured entries backs the Settings →
//! About log viewer; every entry is also mirrored to a plain-text file under
//! `%LOCALAPPDATA%\Vellum\logs\` (machine-local, never OneDrive-synced) for
//! durable export and post-crash diagnosis. Focused on the failure-prone areas
//! (background process lifecycle, runtime download, database); extended
//! incrementally as real issues surface.
//!
//! Distinct from `refine::logbuf::LogBuffer`, which tails Ollama's raw stderr
//! for the Refine debug panel. This log records discrete app-level events.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// Most recent entries kept in memory for the viewer.
const MAX_ENTRIES: usize = 2000;
/// Rotate the on-disk log once it grows past this (one `.old` generation kept).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// RFC 3339, local time.
    pub timestamp: String,
    pub level: Level,
    /// Short subsystem tag (e.g. "ollama", "db", "runtime", "ui").
    pub area: String,
    pub message: String,
}

struct Inner {
    entries: VecDeque<LogEntry>,
    file: Option<File>,
    path: Option<PathBuf>,
}

/// Cheap to clone (shares one inner via `Arc`), so the panic hook, the reader
/// threads, and the Tauri managed state all hold the same log.
#[derive(Clone)]
pub struct AppLog {
    inner: Arc<Mutex<Inner>>,
}

impl Default for AppLog {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: VecDeque::new(),
                file: None,
                path: None,
            })),
        }
    }
}

impl AppLog {
    /// Open (or create) the on-disk log file. Called once at startup after the
    /// data layout exists. Best-effort: a failure leaves file logging off, but
    /// the in-memory buffer keeps working.
    pub fn init_file(&self, path: PathBuf) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Roll over an oversized log so it can't grow without bound.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_FILE_BYTES {
                let _ = std::fs::rename(&path, path.with_extension("log.old"));
            }
        }
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.file = Some(file);
                    inner.path = Some(path);
                }
            }
            Err(e) => eprintln!("applog: cannot open {}: {e}", path.display()),
        }
    }

    pub fn log(&self, level: Level, area: &str, message: impl Into<String>) {
        let entry = LogEntry {
            timestamp: chrono::Local::now().to_rfc3339(),
            level,
            area: area.to_string(),
            message: message.into(),
        };
        // Echo to stderr in dev so `tauri dev` shows it inline.
        #[cfg(debug_assertions)]
        eprintln!("[{}] {}: {}", level.label(), entry.area, entry.message);

        if let Ok(mut inner) = self.inner.lock() {
            if let Some(file) = inner.file.as_mut() {
                let _ = writeln!(
                    file,
                    "{} [{}] {}: {}",
                    entry.timestamp,
                    level.label(),
                    entry.area,
                    entry.message
                );
                let _ = file.flush();
            }
            while inner.entries.len() >= MAX_ENTRIES {
                inner.entries.pop_front();
            }
            inner.entries.push_back(entry);
        }
    }

    pub fn error(&self, area: &str, message: impl Into<String>) {
        self.log(Level::Error, area, message);
    }

    pub fn warn(&self, area: &str, message: impl Into<String>) {
        self.log(Level::Warn, area, message);
    }

    pub fn info(&self, area: &str, message: impl Into<String>) {
        self.log(Level::Info, area, message);
    }

    /// Recent entries (oldest → newest) for the viewer.
    pub fn snapshot(&self) -> Vec<LogEntry> {
        self.inner
            .lock()
            .map(|i| i.entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Clear the in-memory view. The on-disk file is intentionally retained so
    /// an export after "Clear" still has the durable history.
    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.entries.clear();
        }
    }

    /// Full plain-text dump for export: the on-disk file when available (durable,
    /// spans sessions), else the in-memory buffer formatted the same way.
    pub fn export_text(&self) -> String {
        if let Ok(inner) = self.inner.lock() {
            if let Some(path) = inner.path.as_ref() {
                if let Ok(text) = std::fs::read_to_string(path) {
                    return text;
                }
            }
            inner
                .entries
                .iter()
                .map(|e| {
                    format!(
                        "{} [{}] {}: {}",
                        e.timestamp,
                        e.level.label(),
                        e.area,
                        e.message
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            String::new()
        }
    }
}
