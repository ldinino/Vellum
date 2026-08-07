//! Invoking the bundled rclone binary.
//!
//! rclone is an implementation detail: it is shipped as a Tauri sidecar (see
//! docs/satchels-and-sync.md) and never named in the UI. Everything here is
//! one-shot invocation — run to completion, capture output — rather than the
//! long-lived supervised child that `process::ollama` needs.
//!
//! **Never log a raw command line or raw stderr.** Both carry credentials and
//! tokens; `redact` exists for that reason and every log path goes through it.

use std::path::PathBuf;
use std::process::Command;

/// Flags applied to every invocation.
///
/// `--config ""` disables the config file outright: remotes come from
/// `RCLONE_CONFIG_*` environment variables instead, so no credential is ever
/// written to disk in rclone's format, and the user's own
/// `%APPDATA%\rclone\rclone.conf` can't collide with our remote names.
/// `--ask-password=false` makes anything unexpected fail rather than block on a
/// prompt there is no console to answer, and the timeout stops a stalled remote
/// hanging the app forever.
const COMMON_ARGS: &[&str] = &["--config", "", "--ask-password=false", "--contimeout", "30s"];

/// The sidecar next to the running executable. Tauri strips the target-triple
/// suffix when it stages `externalBin`, so it is a plain `rclone.exe` in both
/// `tauri dev` output and an installed app.
pub fn binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve own path: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let candidate = dir.join(if cfg!(windows) { "rclone.exe" } else { "rclone" });
    if candidate.is_file() {
        return Ok(candidate);
    }
    #[cfg(debug_assertions)]
    if let Some(p) = dev_sidecar() {
        return Ok(p);
    }
    Err(format!(
        "sync support is missing from this installation (expected {})",
        candidate.display()
    ))
}

/// Dev fallback: the un-staged sidecar written by scripts/fetch-binaries.ps1,
/// for `cargo run` / tests that bypass `tauri dev`'s staging step.
#[cfg(debug_assertions)]
fn dev_sidecar() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let triple = format!("rclone-{}.exe", current_target_triple());
    let p = dir.join(triple);
    p.is_file().then_some(p)
}

#[cfg(debug_assertions)]
fn current_target_triple() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }
}

/// Output of a completed rclone run.
pub struct RcloneOutput {
    pub stdout: String,
}

/// Run rclone to completion, hidden, and capture its output.
///
/// `env` carries the remote definition as `RCLONE_CONFIG_*` pairs. Secrets go
/// through the environment rather than argv because argv is readable by any
/// process on the machine via the process list; environment is not.
pub fn run(env: &[(String, String)], args: &[&str]) -> Result<RcloneOutput, String> {
    let bin = binary_path()?;
    let mut command = Command::new(&bin);
    command.args(COMMON_ARGS).args(args);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("could not start sync support: {e}"))?;
    if !output.status.success() {
        return Err(translate_error(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(RcloneOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    })
}

/// rclone's version string, e.g. "v1.75.0". Doubles as a cheap proof that the
/// sidecar is present and executable.
pub fn version() -> Result<String, String> {
    let bin = binary_path()?;
    let mut command = Command::new(&bin);
    command.arg("version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|e| format!("could not start sync support: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // First line is "rclone v1.75.0"; anything else means we ran the wrong thing.
    stdout
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("rclone "))
        .map(|v| v.trim().to_string())
        .ok_or_else(|| "sync support did not report a usable version".to_string())
}

/// Like [`run`], but feeds `body` to rclone on stdin — used by `rcat` so small
/// files (the lease) can be written straight to the remote without staging them
/// on local disk or passing their contents through argv.
pub fn run_with_stdin(
    env: &[(String, String)],
    args: &[&str],
    body: &str,
) -> Result<RcloneOutput, String> {
    use std::io::Write;
    use std::process::Stdio;

    let bin = binary_path()?;
    let mut command = Command::new(&bin);
    command
        .args(COMMON_ARGS)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start sync support: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "could not write to sync support".to_string())?
        .write_all(body.as_bytes())
        .map_err(|e| format!("could not write to sync support: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("sync support did not finish: {e}"))?;
    if !output.status.success() {
        return Err(translate_error(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(RcloneOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    })
}

/// Name of the throwaway object written by `probe`.
const PROBE_FILE: &str = ".vellum-probe";

/// Prove a remote is actually usable: create the target folder, write a file,
/// see it listed, then delete it. A misconfigured remote must be impossible to
/// save, and a credential that is merely *accepted* is not enough — read-only
/// keys and missing buckets both pass authentication and then fail at first
/// sync, which is far harder to diagnose.
///
/// `target` is an rclone destination such as `vellumcrypt:`.
pub fn probe(env: &[(String, String)], target: &str) -> Result<(), String> {
    let probe_path = format!("{}/{PROBE_FILE}", target.trim_end_matches('/'));

    run(env, &["mkdir", target])?;
    run(env, &["touch", &probe_path])?;

    let listing = run(env, &["lsf", target])?;
    if !listing.stdout.lines().any(|l| l.trim() == PROBE_FILE) {
        // Deliberately not a hard error path for cleanup: leave the probe file
        // rather than risk deleting something else on a surprising backend.
        return Err(
            "The storage accepted the file but didn't list it back. It may be read-only.".into(),
        );
    }

    run(env, &["deletefile", &probe_path])
        .map_err(|_| "The storage is readable but files can't be deleted from it.".to_string())?;
    Ok(())
}

/// rclone's "obscured" form of a password, which is the only format a `crypt`
/// remote accepts. Obscuring is *not* encryption — it is a fixed, reversible
/// transform; the DPAPI blob is what actually protects these at rest.
pub fn obscure(plaintext: &str) -> Result<String, String> {
    let out = run(&[], &["obscure", plaintext])?;
    let value = out.stdout.trim().to_string();
    if value.is_empty() {
        return Err("could not prepare the encryption key".into());
    }
    Ok(value)
}

/// Mask secrets in an argument list so it is safe to log. Matches the flags and
/// value shapes that actually carry credentials; anything unrecognised is kept,
/// since an over-broad filter would make logs useless.
pub fn redact(args: &[&str]) -> String {
    const SECRET_FLAGS: &[&str] = &[
        "--password",
        "--pass",
        "--secret-access-key",
        "--access-key-id",
        "--client-secret",
        "--token",
    ];
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for arg in args {
        if mask_next {
            out.push("<redacted>".into());
            mask_next = false;
            continue;
        }
        // `key=value` config assignments carry secrets in the value half.
        if let Some((key, _)) = arg.split_once('=') {
            if SECRET_FLAGS.contains(&key)
                || key.ends_with("pass")
                || key.ends_with("password")
                || key.ends_with("key")
                || key.ends_with("secret")
                || key.ends_with("token")
            {
                out.push(format!("{key}=<redacted>"));
                continue;
            }
        }
        if SECRET_FLAGS.contains(arg) {
            mask_next = true;
        }
        out.push((*arg).to_string());
    }
    out.join(" ")
}

/// Turn rclone's diagnostic stderr into something a person can act on. The raw
/// text is deliberately dropped here — callers log the translated message only.
fn translate_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let known = [
        ("authenticationfailed", "The credentials were rejected. Check the key and secret, then try again."),
        ("403", "The credentials were rejected. Check the key and secret, then try again."),
        ("invalidaccesskeyid", "That access key isn't recognised by the provider."),
        ("signaturedoesnotmatch", "That secret key doesn't match the access key."),
        ("nosuchbucket", "That bucket doesn't exist. Check the name, or create it with your provider."),
        ("requesttimetooskewed", "This machine's clock is too far off. Fix the system time and try again."),
        ("no such host", "Couldn't reach the storage provider. Check the endpoint address and your connection."),
        ("network is unreachable", "No network connection."),
        ("connection refused", "The storage provider refused the connection. Check the endpoint address."),
        ("didn't find section in config file", "That remote is no longer configured."),
        ("couldn't decrypt configuration", "The stored configuration couldn't be unlocked."),
    ];
    for (needle, message) in known {
        if lower.contains(needle) {
            return message.to_string();
        }
    }
    "Sync failed. See the app log for details.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_values_but_keeps_structure() {
        let args = ["config", "create", "b2", "s3", "--secret-access-key", "hunter2"];
        assert_eq!(redact(&args), "config create b2 s3 --secret-access-key <redacted>");
    }

    #[test]
    fn redacts_key_value_assignments() {
        let args = ["config", "create", "r", "s3", "secret_access_key=hunter2", "region=us-west"];
        let out = redact(&args);
        assert!(out.contains("secret_access_key=<redacted>"), "{out}");
        assert!(out.contains("region=us-west"), "region is not a secret: {out}");
        assert!(!out.contains("hunter2"), "secret leaked: {out}");
    }

    #[test]
    fn translates_known_failures_and_never_echoes_stderr() {
        let raw = "2026/08/06 ERROR : SignatureDoesNotMatch: secret=hunter2";
        let msg = translate_error(raw);
        assert!(!msg.contains("hunter2"), "raw stderr leaked into the message: {msg}");
        assert!(msg.contains("secret key"), "{msg}");
        assert_eq!(
            translate_error("something nobody has seen before"),
            "Sync failed. See the app log for details."
        );
    }

    /// Proves the bundled sidecar is actually present and executable — the whole
    /// point of shipping it rather than downloading it. Skips (rather than
    /// fails) when the binary hasn't been fetched, so a fresh clone that hasn't
    /// run scripts/fetch-binaries.ps1 still gets a green suite.
    #[test]
    fn bundled_binary_runs_and_reports_a_version() {
        let Ok(path) = binary_path() else {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        };
        assert!(path.is_file(), "{} is not a file", path.display());
        let v = version().expect("rclone should report its version");
        assert!(v.starts_with('v'), "unexpected version string: {v}");
    }

    /// Exercises the real write/list/delete round trip against rclone's `:local:`
    /// backend, which needs no credentials — so the probe logic is covered
    /// without a network or an account.
    #[test]
    fn probe_round_trips_against_a_local_backend() {
        if binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let dir = std::env::temp_dir().join(format!("vellum-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let target = format!(":local:{}", dir.join("remote").display());
        probe(&[], &target).expect("probe should succeed against a local directory");

        // The probe cleans up after itself: the folder exists, the file doesn't.
        assert!(dir.join("remote").is_dir());
        assert!(!dir.join("remote").join(PROBE_FILE).exists(), "probe file was left behind");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_reports_a_useful_error_for_an_unknown_remote() {
        if binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let err = probe(&[], "nosuchremote:bucket").unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains("NOTICE"), "raw rclone output leaked: {err}");
    }

    /// The whole security story rests on this: a remote defined only by
    /// environment variables, wrapped in `crypt`, encrypts names and contents on
    /// disk while reading back cleanly.
    #[test]
    fn crypt_remote_from_env_encrypts_on_disk_and_reads_back() {
        if binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let dir = std::env::temp_dir().join(format!("vellum-crypt-{}", uuid::Uuid::new_v4()));
        let store = dir.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let source = dir.join("page.txt");
        std::fs::write(&source, b"secret notes").unwrap();

        let env = vec![
            ("RCLONE_CONFIG_BASE_TYPE".to_string(), "local".to_string()),
            ("RCLONE_CONFIG_VC_TYPE".to_string(), "crypt".to_string()),
            (
                "RCLONE_CONFIG_VC_REMOTE".to_string(),
                format!("base:{}", store.display()),
            ),
            (
                "RCLONE_CONFIG_VC_PASSWORD".to_string(),
                obscure("correct-horse-battery").unwrap(),
            ),
            (
                "RCLONE_CONFIG_VC_PASSWORD2".to_string(),
                obscure("salt-value-here").unwrap(),
            ),
        ];

        run(&env, &["copy", &source.to_string_lossy(), "vc:"]).unwrap();

        let on_disk: Vec<String> = std::fs::read_dir(&store)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(on_disk.len(), 1, "expected exactly one stored object");
        assert_ne!(on_disk[0], "page.txt", "filename was not encrypted at rest");

        let listed = run(&env, &["lsf", "vc:"]).unwrap();
        assert_eq!(listed.stdout.trim(), "page.txt", "name did not decrypt");
        let content = run(&env, &["cat", "vc:page.txt"]).unwrap();
        assert_eq!(content.stdout, "secret notes", "content did not decrypt");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
