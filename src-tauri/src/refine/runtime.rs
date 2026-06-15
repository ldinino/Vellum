//! Ollama runtime install (spec Section 3, "Runtime components"; Phase 7).
//!
//! Downloads the pinned `ollama-windows-amd64.zip` into
//! `%LOCALAPPDATA%\Vellum\runtime\ollama\<version>\`, verifying SHA-256 before
//! extracting. The flow is:
//!   - idempotent: skip if the version's `ollama.exe` is already present;
//!   - atomic-ish: download + verify + extract inside a temp work dir, then
//!     rename the extracted tree into place; a guard removes the work dir on any
//!     exit so a failed install never leaves partials behind;
//!   - retry-tolerant: transient network errors retry with backoff (the whole
//!     command is also re-invokable);
//!   - cancellable: `refine_cancel_install` flips a flag the download loop checks.
//!
//! Models are NOT handled here — Ollama pulls and verifies those itself (see
//! `refine::models`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::events;
use super::manifest;
use crate::paths;
use crate::process::ollama;

const MAX_ATTEMPTS: u32 = 3;

/// Single-install lock + cancel flag, managed in app state.
#[derive(Default)]
pub struct InstallState {
    in_progress: AtomicBool,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgress {
    /// "downloading" | "verifying" | "extracting" | "done" | "error"
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// 1-based; surfaces retries to the UI.
    pub attempt: u32,
    pub message: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    }
}

/// Is the manifest's pinned Ollama version installed?
pub fn runtime_status(app: &AppHandle) -> Result<RuntimeStatus, String> {
    let manifest = manifest::load_manifest(app)?;
    let version = manifest.ollama.version;
    let dir = paths::ollama_component_dir(app)?.join(&version);
    let exe = dir.join(exe_name());
    Ok(if exe.is_file() {
        RuntimeStatus {
            installed: true,
            version: Some(version),
            path: Some(dir.display().to_string()),
        }
    } else {
        RuntimeStatus {
            installed: false,
            version: Some(version),
            path: None,
        }
    })
}

pub fn cancel_install(app: &AppHandle) {
    app.state::<InstallState>().cancel.store(true, Ordering::SeqCst);
}

/// Download + verify + extract the pinned runtime. Idempotent; emits
/// `refine://runtime-progress`. Guards against concurrent installs.
pub async fn install_runtime(app: AppHandle) -> Result<RuntimeStatus, String> {
    // Windows-only: the pinned URL is the windows-amd64 build.
    if !cfg!(windows) {
        return Err("The Refine runtime is only available on Windows in v1".into());
    }

    // Already installed? Skip the lock and the download entirely.
    let status = runtime_status(&app)?;
    if status.installed {
        return Ok(status);
    }

    let cancel = {
        let st = app.state::<InstallState>();
        if st.in_progress.swap(true, Ordering::SeqCst) {
            return Err("A runtime download is already in progress".into());
        }
        st.cancel.store(false, Ordering::SeqCst);
        st.cancel.clone()
    };

    let result = install_inner(&app, &cancel).await;

    app.state::<InstallState>()
        .in_progress
        .store(false, Ordering::SeqCst);

    match &result {
        Ok(_) => emit(&app, done_progress()),
        Err(e) => emit(&app, error_progress(e)),
    }
    result
}

async fn install_inner(app: &AppHandle, cancel: &AtomicBool) -> Result<RuntimeStatus, String> {
    let manifest = manifest::load_manifest(app)?;
    let pin = manifest.ollama;
    let component_dir = paths::ollama_component_dir(app)?;
    let dest = component_dir.join(&pin.version);
    let tmp_root = component_dir.join(".tmp");

    let app_for_emit = app.clone();
    install_from_url(
        &reqwest::Client::new(),
        &pin.url,
        &pin.sha256,
        pin.size_bytes,
        &dest,
        &tmp_root,
        cancel,
        move |p| emit(&app_for_emit, p),
    )
    .await?;

    runtime_status(app)
}

/// Testable core (no Tauri, no app state). `emit` receives progress.
#[allow(clippy::too_many_arguments)]
async fn install_from_url(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    expected_size: u64,
    dest_version_dir: &Path,
    tmp_root: &Path,
    cancel: &AtomicBool,
    mut emit: impl FnMut(RuntimeProgress),
) -> Result<(), String> {
    if dest_version_dir.join(exe_name()).is_file() {
        return Ok(()); // idempotent
    }

    std::fs::create_dir_all(tmp_root).map_err(|e| format!("create {}: {e}", tmp_root.display()))?;
    let work = tmp_root.join(format!("install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| format!("create {}: {e}", work.display()))?;
    let _guard = PartialCleanup(work.clone());

    let zip_path = work.join("ollama.zip");

    // --- download (with retry on transient errors) ---
    let mut attempt = 0;
    loop {
        attempt += 1;
        check_cancel(cancel)?;
        match download(client, url, &zip_path, expected_size, attempt, cancel, &mut emit).await {
            Ok(()) => break,
            Err(DownloadError::Cancelled) => return Err("cancelled".into()),
            Err(DownloadError::Transient(e)) if attempt < MAX_ATTEMPTS => {
                emit(RuntimeProgress {
                    phase: "downloading".into(),
                    downloaded_bytes: 0,
                    total_bytes: None,
                    attempt,
                    message: Some(format!("network error, retrying: {e}")),
                });
                tokio::time::sleep(backoff(attempt)).await;
            }
            Err(DownloadError::Transient(e)) | Err(DownloadError::Fatal(e)) => return Err(e),
        }
    }

    // --- verify (blocking) BEFORE extract ---
    emit(phase("verifying", attempt));
    let zp = zip_path.clone();
    let actual = tauri::async_runtime::spawn_blocking(move || sha256_file(&zp))
        .await
        .map_err(|e| format!("hash task join error: {e}"))??;
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "runtime download is corrupt: sha256 {actual} does not match the pinned {expected_sha256}"
        ));
    }

    // --- extract (blocking) into work/extracted ---
    emit(phase("extracting", attempt));
    let extracted = work.join("extracted");
    let zp = zip_path.clone();
    let ex = extracted.clone();
    tauri::async_runtime::spawn_blocking(move || extract_zip(&zp, &ex))
        .await
        .map_err(|e| format!("extract task join error: {e}"))??;

    if !extracted.join(exe_name()).is_file() {
        return Err(format!("extracted runtime is missing {}", exe_name()));
    }

    // --- publish atomically ---
    if let Some(parent) = dest_version_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    match std::fs::rename(&extracted, dest_version_dir) {
        Ok(()) => {}
        // Lost a race with another install of the same version — that's fine.
        Err(_) if dest_version_dir.join(exe_name()).is_file() => {}
        Err(e) => {
            return Err(format!(
                "publish {} -> {}: {e}",
                extracted.display(),
                dest_version_dir.display()
            ))
        }
    }
    Ok(())
}

enum DownloadError {
    Cancelled,
    /// Worth retrying (timeout, connection reset, 5xx).
    Transient(String),
    /// Not worth retrying (4xx, disk write error).
    Fatal(String),
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_size: u64,
    attempt: u32,
    cancel: &AtomicBool,
    emit: &mut impl FnMut(RuntimeProgress),
) -> Result<(), DownloadError> {
    use std::io::Write;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| classify_reqwest(&e))?;
    let status = resp.status();
    if !status.is_success() {
        let msg = format!("download failed: HTTP {status}");
        return Err(if status.is_server_error() {
            DownloadError::Transient(msg)
        } else {
            DownloadError::Fatal(msg)
        });
    }

    let total = resp
        .content_length()
        .or((expected_size > 0).then_some(expected_size));

    let file = std::fs::File::create(dest)
        .map_err(|e| DownloadError::Fatal(format!("create {}: {e}", dest.display())))?;
    let mut writer = std::io::BufWriter::new(file);

    let mut downloaded = 0u64;
    let mut last = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let chunk = chunk.map_err(|e| DownloadError::Transient(e.to_string()))?;
        writer
            .write_all(&chunk)
            .map_err(|e| DownloadError::Fatal(format!("write {}: {e}", dest.display())))?;
        downloaded += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(100) {
            emit(RuntimeProgress {
                phase: "downloading".into(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                attempt,
                message: None,
            });
            last = Instant::now();
        }
    }
    writer
        .flush()
        .map_err(|e| DownloadError::Fatal(format!("flush {}: {e}", dest.display())))?;

    // Final 100% tick so the bar lands exactly.
    emit(RuntimeProgress {
        phase: "downloading".into(),
        downloaded_bytes: downloaded,
        total_bytes: total.or(Some(downloaded)),
        attempt,
        message: None,
    });
    Ok(())
}

fn classify_reqwest(e: &reqwest::Error) -> DownloadError {
    if e.is_timeout() || e.is_connect() || e.is_request() {
        DownloadError::Transient(e.to_string())
    } else {
        DownloadError::Fatal(e.to_string())
    }
}

fn backoff(attempt: u32) -> Duration {
    // 0.5s, 1.5s, 4.5s, ...
    Duration::from_millis(500 * 3u64.pow(attempt.saturating_sub(1)))
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("hash {}: {e}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Extract `zip_path` into `dest`, rejecting any entry that would escape `dest`
/// (zip-slip). `dest` is created if missing.
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        // `enclosed_name` returns None for absolute paths or `..` traversal.
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe zip entry name: {}", entry.name()))?;
        let out = dest.join(&rel);
        if !out.starts_with(dest) {
            return Err(format!("zip entry escapes destination: {}", entry.name()));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            let mut w = std::fs::File::create(&out)
                .map_err(|e| format!("create {}: {e}", out.display()))?;
            std::io::copy(&mut entry, &mut w)
                .map_err(|e| format!("write {}: {e}", out.display()))?;
        }
    }
    Ok(())
}

fn phase(name: &str, attempt: u32) -> RuntimeProgress {
    RuntimeProgress {
        phase: name.into(),
        downloaded_bytes: 0,
        total_bytes: None,
        attempt,
        message: None,
    }
}

fn done_progress() -> RuntimeProgress {
    phase("done", MAX_ATTEMPTS)
}

fn error_progress(msg: &str) -> RuntimeProgress {
    RuntimeProgress {
        phase: "error".into(),
        downloaded_bytes: 0,
        total_bytes: None,
        attempt: 0,
        message: Some(msg.to_string()),
    }
}

fn emit(app: &AppHandle, p: RuntimeProgress) {
    let _ = app.emit(events::RUNTIME_PROGRESS, p);
}

/// Removes its directory on drop unless the install moved everything out. Cheap
/// insurance against leaving multi-hundred-MB partials behind on any error path.
struct PartialCleanup(PathBuf);
impl Drop for PartialCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// re-exported sentinel for callers that need to detect "not installed".
pub use ollama::ERR_RUNTIME_NOT_INSTALLED;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;

    fn sha256_bytes(b: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b);
        format!("{:x}", h.finalize())
    }

    /// Build a tiny in-memory zip containing ollama.exe + lib/runner.txt.
    fn make_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            w.start_file(exe_name(), opts).unwrap();
            w.write_all(b"fake ollama binary").unwrap();
            w.add_directory("lib", opts).unwrap();
            w.start_file("lib/runner.txt", opts).unwrap();
            w.write_all(b"runner").unwrap();
            w.finish().unwrap();
        }
        buf
    }

    /// A zip with a `..` traversal entry, to exercise the zip-slip guard.
    fn make_evil_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            w.start_file("../escaped.txt", opts).unwrap();
            w.write_all(b"pwned").unwrap();
            w.finish().unwrap();
        }
        buf
    }

    /// Minimal one-shot HTTP server. `fail_first` connections are accepted then
    /// dropped (simulating a transient network error) before a good response is
    /// served. Returns the bound URL.
    fn serve(body: Vec<u8>, fail_first: usize) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ollama.zip", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut served_failures = 0;
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                if served_failures < fail_first {
                    served_failures += 1;
                    drop(stream); // accept then close → connection reset
                    continue;
                }
                use std::io::{Read, Write};
                let mut tmp = [0u8; 1024];
                let _ = stream.read(&mut tmp); // consume request line(s)
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
                break; // one good response is enough for these tests
            }
        });
        (url, handle)
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("vellum-rt-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn happy_path_installs_and_is_idempotent() {
        let zip = make_zip();
        let sha = sha256_bytes(&zip);
        let (url, _h) = serve(zip, 0);
        let root = tmpdir("happy");
        let dest = root.join("v9.9.9");
        let tmp = root.join(".tmp");
        let cancel = AtomicBool::new(false);

        install_from_url(
            &reqwest::Client::new(),
            &url,
            &sha,
            0,
            &dest,
            &tmp,
            &cancel,
            |_p| {},
        )
        .await
        .expect("install ok");

        assert!(dest.join(exe_name()).is_file());
        assert!(dest.join("lib").join("runner.txt").is_file());
        // temp work dir was cleaned up
        assert!(std::fs::read_dir(&tmp).map(|mut d| d.next().is_none()).unwrap_or(true));

        // Idempotent: a second run with an unreachable URL still succeeds.
        install_from_url(
            &reqwest::Client::new(),
            "http://127.0.0.1:1/nope.zip",
            &sha,
            0,
            &dest,
            &tmp,
            &cancel,
            |_p| {},
        )
        .await
        .expect("idempotent skip");

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn sha_mismatch_fails_and_cleans_partials() {
        let zip = make_zip();
        let (url, _h) = serve(zip, 0);
        let root = tmpdir("badsha");
        let dest = root.join("v1");
        let tmp = root.join(".tmp");
        let cancel = AtomicBool::new(false);

        let err = install_from_url(
            &reqwest::Client::new(),
            &url,
            &"00".repeat(32), // wrong sha
            0,
            &dest,
            &tmp,
            &cancel,
            |_p| {},
        )
        .await
        .unwrap_err();

        assert!(err.contains("corrupt"), "err: {err}");
        assert!(!dest.exists(), "nothing published on bad sha");
        // work dir cleaned by the guard
        assert!(std::fs::read_dir(&tmp).map(|mut d| d.next().is_none()).unwrap_or(true));
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn retries_then_succeeds() {
        let zip = make_zip();
        let sha = sha256_bytes(&zip);
        let (url, _h) = serve(zip, 2); // drop the first two connections
        let root = tmpdir("retry");
        let dest = root.join("v1");
        let tmp = root.join(".tmp");
        let cancel = AtomicBool::new(false);

        let mut max_attempt = 0;
        install_from_url(
            &reqwest::Client::new(),
            &url,
            &sha,
            0,
            &dest,
            &tmp,
            &cancel,
            |p| max_attempt = max_attempt.max(p.attempt),
        )
        .await
        .expect("eventually installs");

        assert!(dest.join(exe_name()).is_file());
        assert!(max_attempt >= 3, "should have retried, saw attempt {max_attempt}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn rejects_zip_slip() {
        let zip = make_evil_zip();
        let sha = sha256_bytes(&zip);
        let (url, _h) = serve(zip, 0);
        let root = tmpdir("evil");
        let dest = root.join("v1");
        let tmp = root.join(".tmp");
        let cancel = AtomicBool::new(false);

        let err = install_from_url(
            &reqwest::Client::new(),
            &url,
            &sha,
            0,
            &dest,
            &tmp,
            &cancel,
            |_p| {},
        )
        .await
        .unwrap_err();

        assert!(err.contains("unsafe") || err.contains("escapes"), "err: {err}");
        assert!(!root.join("escaped.txt").exists());
        assert!(!dest.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn extract_zip_writes_tree() {
        let zip = make_zip();
        let root = tmpdir("ex");
        let zp = root.join("a.zip");
        std::fs::write(&zp, &zip).unwrap();
        let out = root.join("out");
        extract_zip(&zp, &out).unwrap();
        assert!(out.join(exe_name()).is_file());
        assert_eq!(std::fs::read(out.join("lib/runner.txt")).unwrap(), b"runner");
        std::fs::remove_dir_all(&root).ok();
    }
}
