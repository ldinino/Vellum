//! Ollama lifecycle (spec Sections 3 and 9).
//!
//! Spawned only when Refine is enabled, bound to 127.0.0.1:11435 with models
//! under %LOCALAPPDATA%\Vellum\runtime\models\, killed on app exit. Never
//! started when Refine is disabled in settings.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::{ManagedChild, LogSink, ProcessStatus};
use crate::refine::events;
use crate::refine::logbuf::{LogBuffer, LogLine};
use crate::{config, paths};

pub const OLLAMA_PORT: u16 = 11435;

#[derive(Default)]
pub struct OllamaState(pub Mutex<Option<ManagedChild>>);

/// Locate ollama.exe: a downloaded runtime component first
/// (runtime\ollama\<version>\ollama.exe, newest version wins), then the
/// dev-machine vendor copy in debug builds.
fn resolve_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let component_dir = paths::runtime_dir(app)?.join("ollama");
    if let Ok(entries) = std::fs::read_dir(&component_dir) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.join(exe_name()).is_file())
            .collect();
        versions.sort();
        if let Some(latest) = versions.pop() {
            return Ok(latest.join(exe_name()));
        }
    }

    #[cfg(debug_assertions)]
    if let Some(vendor) = paths::vendor_bin_dir() {
        let candidate = vendor.join("ollama").join(exe_name());
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("Ollama runtime component is not installed".into())
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    }
}

pub fn start(app: &AppHandle, state: &OllamaState) -> Result<ProcessStatus, String> {
    // Hard gate: Refine disabled means Ollama never spawns (spec Section 9).
    let cfg = config::load_app_config(app)?;
    if !cfg.settings.refine_enabled {
        return Err("Refine is disabled in Settings; Ollama will not be started".into());
    }

    let mut guard = state.0.lock().map_err(|_| "ollama state poisoned")?;
    if let Some(existing) = guard.as_mut() {
        if existing.is_running() {
            return Ok(ProcessStatus {
                running: true,
                pid: Some(existing.pid),
                port: Some(OLLAMA_PORT),
            });
        }
        guard.take();
    }

    let binary = resolve_binary(app)?;
    let models_dir = paths::runtime_dir(app)?.join("models");
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| format!("create {}: {e}", models_dir.display()))?;

    let mut cmd = Command::new(&binary);
    cmd.arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{OLLAMA_PORT}"))
        .env("OLLAMA_MODELS", &models_dir);

    // Capture stderr into the ring buffer and tail it via an event, for the
    // debug panel (spec Section 9). Fresh buffer per serve session.
    let buffer = app.state::<LogBuffer>().inner().clone();
    buffer.clear();
    let app_for_log = app.clone();
    let sink: LogSink = Box::new(move |line: String| {
        buffer.push(line.clone());
        let _ = app_for_log.emit(events::OLLAMA_LOG, LogLine { line });
    });

    let child = ManagedChild::spawn_with_stderr(cmd, Some(sink))?;
    let pid = child.pid;
    *guard = Some(child);
    drop(guard);

    if !super::wait_for_port(OLLAMA_PORT, Duration::from_secs(15)) {
        stop(state)?;
        return Err(format!(
            "Ollama did not start listening on port {OLLAMA_PORT} within 15s"
        ));
    }

    Ok(ProcessStatus {
        running: true,
        pid: Some(pid),
        port: Some(OLLAMA_PORT),
    })
}

pub fn stop(state: &OllamaState) -> Result<ProcessStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "ollama state poisoned")?;
    if let Some(mut child) = guard.take() {
        child.kill();
    }
    Ok(ProcessStatus::default())
}

pub fn status(state: &OllamaState) -> Result<ProcessStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "ollama state poisoned")?;
    if let Some(child) = guard.as_mut() {
        if child.is_running() {
            return Ok(ProcessStatus {
                running: true,
                pid: Some(child.pid),
                port: Some(OLLAMA_PORT),
            });
        }
        guard.take();
    }
    Ok(ProcessStatus::default())
}
