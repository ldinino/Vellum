//! A small, bounded ring buffer for Ollama's stderr, fed by the stderr-reader
//! thread in `ManagedChild::spawn_with_stderr`. The debug panel (spec Section 9)
//! reads a snapshot for backfill and tails the `OLLAMA_LOG` event for live
//! lines. In-memory only — never persisted.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const MAX_LINES: usize = 2000;

/// Cheap to clone (shares one inner buffer via `Arc`), so the reader thread and
/// the Tauri managed state hold the same lines.
#[derive(Clone, Default)]
pub struct LogBuffer {
    inner: Arc<Mutex<VecDeque<String>>>,
}

impl LogBuffer {
    pub fn push(&self, line: String) {
        if let Ok(mut q) = self.inner.lock() {
            while q.len() >= MAX_LINES {
                q.pop_front();
            }
            q.push_back(line);
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop everything — called when a fresh `ollama serve` starts so the panel
    /// shows only the current session.
    pub fn clear(&self) {
        if let Ok(mut q) = self.inner.lock() {
            q.clear();
        }
    }
}

/// Payload for the `refine://ollama-log` event.
#[derive(Serialize, Clone)]
pub struct LogLine {
    pub line: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_past_cap() {
        let b = LogBuffer::default();
        for i in 0..(MAX_LINES + 10) {
            b.push(format!("line {i}"));
        }
        let snap = b.snapshot();
        assert_eq!(snap.len(), MAX_LINES);
        assert_eq!(snap.first().unwrap(), "line 10"); // first 10 evicted
        assert_eq!(snap.last().unwrap(), &format!("line {}", MAX_LINES + 9));
    }

    #[test]
    fn clear_empties() {
        let b = LogBuffer::default();
        b.push("a".into());
        b.clear();
        assert!(b.snapshot().is_empty());
    }
}
