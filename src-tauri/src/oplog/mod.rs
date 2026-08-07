//! The change log (docs/satchels-and-sync.md, OPLOG).
//!
//! Every notebook mutation is recorded as an intent, alongside the SQLite
//! database rather than instead of it. During this shadow period the log is
//! written and verified but never read by the app: the database stays
//! authoritative, and the log is proving it could take over.
//!
//! What is being proved is completeness. The failure that matters in phase B is
//! a mutation path that forgot to log, and an absent entry is invisible in a
//! log — you cannot spot it by reading. So the log is checked by rebuilding a
//! database from it and comparing against the live one (see `verify`).

pub mod clock;
pub mod record;
pub mod writer;

use std::path::Path;

use clock::Clock;
use record::{Op, Record};

/// Process-wide clock, so stamps are monotonic across every notebook this
/// device touches rather than only within one.
// Unused until the mutation paths are instrumented in the next step.
#[allow(dead_code)]
static CLOCK: std::sync::OnceLock<Clock> = std::sync::OnceLock::new();

#[allow(dead_code)]
fn clock() -> &'static Clock {
    CLOCK.get_or_init(Clock::default)
}

/// Record an intent, best-effort.
///
/// **Failures are swallowed deliberately.** The log is shadow data: refusing an
/// edit because its log line couldn't be written would trade a real feature for
/// a speculative one. A dropped record surfaces as a mismatch in `verify`,
/// which is exactly the signal the shadow period exists to collect.
#[allow(dead_code)]
pub fn record(notebook_dir: &Path, device_id: &str, op: Op) {
    let entry = Record::new(device_id, clock().now(), op);
    if let Err(e) = writer::append(notebook_dir, device_id, &entry) {
        // Not through the app log: this can fire on every keystroke-driven
        // save, and a failing disk should not also flood the diagnostics.
        eprintln!("oplog: {e}");
    }
}
