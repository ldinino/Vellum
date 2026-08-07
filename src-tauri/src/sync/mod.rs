//! BYO sync (docs/satchels-and-sync.md, phase A).
//!
//! Scope is the whole Satchel — settings travel with it, so `app.json` is part
//! of the synced payload and the single-writer lease is per-Satchel rather than
//! per-notebook.

// The wrapper lands before the config/setup layers that call it; the allow comes
// off once phase A is wired to commands.
#[allow(dead_code)]
pub mod rclone;
#[allow(dead_code)]
pub mod secrets;
