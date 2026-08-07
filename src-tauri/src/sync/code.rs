//! The connection code: everything a second device needs, in one paste.
//!
//! Re-entering an endpoint, a key pair and a crypt password by hand on device 2
//! is where BYO sync usually falls apart — and a mistyped crypt password does
//! not fail loudly, it silently creates a second, invisible copy of the data.
//! So the whole remote definition travels as a single string.
//!
//! That string carries live credentials, so it is encrypted under a passphrase
//! the user chooses; the passphrase is the only thing they have to remember or
//! transport, which makes the code safe to email to yourself.
//!
//! The encryption is rclone's own `crypt` (scrypt + XSalsa20-Poly1305), driven
//! through the bundled binary. That avoids adding a cipher and a KDF as
//! dependencies, and means one vetted primitive protects both the notebooks and
//! the code that unlocks them. The plaintext never touches disk: it goes in on
//! stdin and comes back on stdout.

use base64::Engine;
use std::path::PathBuf;

use super::rclone;
use super::remote::RemoteConfig;

/// Versioned so a future format can be recognised and rejected clearly instead
/// of failing as corrupt.
const PREFIX: &str = "VELLUM-SYNC-1:";

/// Short passphrases make the code cheap to crack offline once intercepted.
const MIN_PASSPHRASE: usize = 8;

/// Remote names must be longer than one character: on Windows rclone reads a
/// single-letter prefix as a drive letter, so `c:code` means drive C.
const BASE: &str = "codebase";
const CRYPT: &str = "codecrypt";

/// The object name inside the crypt remote. rclone appends its own `.bin`
/// suffix when filename encryption is off, so this is stored as `code.bin`.
const OBJECT: &str = "code";
const STORED_FILE: &str = "code.bin";

/// A temp directory that cleans itself up, including on the error paths — it
/// only ever holds ciphertext, but leaving litter around is still sloppy.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let p = std::env::temp_dir().join(format!("vellum-code-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).map_err(|e| format!("could not create a work folder: {e}"))?;
        Ok(Self(p))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn crypt_env(dir: &std::path::Path, passphrase: &str) -> Result<Vec<(String, String)>, String> {
    Ok(vec![
        (format!("RCLONE_CONFIG_{}_TYPE", BASE.to_uppercase()), "local".into()),
        (format!("RCLONE_CONFIG_{}_TYPE", CRYPT.to_uppercase()), "crypt".into()),
        (
            format!("RCLONE_CONFIG_{}_REMOTE", CRYPT.to_uppercase()),
            format!("{BASE}:{}", dir.display()),
        ),
        (
            format!("RCLONE_CONFIG_{}_PASSWORD", CRYPT.to_uppercase()),
            rclone::obscure(passphrase)?,
        ),
        // Keeps the object at a name we can find; the contents are still
        // encrypted, which is all this needs to do.
        (
            format!("RCLONE_CONFIG_{}_FILENAME_ENCRYPTION", CRYPT.to_uppercase()),
            "off".into(),
        ),
    ])
}

fn check_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!(
            "Use a passphrase of at least {MIN_PASSPHRASE} characters."
        ));
    }
    Ok(())
}

/// Encrypt a remote definition into a single pasteable string.
pub fn encode(config: &RemoteConfig, passphrase: &str) -> Result<String, String> {
    check_passphrase(passphrase)?;
    let scratch = Scratch::new()?;
    let env = crypt_env(&scratch.0, passphrase)?;

    let json = serde_json::to_string(config).map_err(|e| format!("serialize remote: {e}"))?;
    rclone::run_with_stdin(&env, &["rcat", &format!("{CRYPT}:{OBJECT}")], &json)?;

    let sealed = std::fs::read(scratch.0.join(STORED_FILE))
        .map_err(|e| format!("could not read back the connection code: {e}"))?;
    Ok(format!(
        "{PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(sealed)
    ))
}

/// Recover a remote definition from a connection code.
pub fn decode(code: &str, passphrase: &str) -> Result<RemoteConfig, String> {
    check_passphrase(passphrase)?;
    // Tolerate the whitespace and line breaks that survive a trip through email.
    let cleaned: String = code.split_whitespace().collect();
    let body = cleaned
        .strip_prefix(PREFIX)
        .ok_or_else(|| "That doesn't look like a Vellum connection code.".to_string())?;
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "That connection code is incomplete or damaged.".to_string())?;

    let scratch = Scratch::new()?;
    std::fs::write(scratch.0.join(STORED_FILE), &sealed)
        .map_err(|e| format!("could not stage the connection code: {e}"))?;

    let env = crypt_env(&scratch.0, passphrase)?;
    let out = rclone::run(&env, &["cat", &format!("{CRYPT}:{OBJECT}")])
        .map_err(|_| "That passphrase doesn't unlock this connection code.".to_string())?;
    serde_json::from_str(&out.stdout)
        .map_err(|_| "That connection code is damaged.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn sample() -> RemoteConfig {
        let mut options = BTreeMap::new();
        options.insert("access_key_id".into(), "AKIA".into());
        options.insert("secret_access_key".into(), "hunter2".into());
        RemoteConfig {
            backend: "s3".into(),
            label: "Backblaze B2".into(),
            options,
            path: "my-bucket/vellum".into(),
            crypt_password: "obscured-1".into(),
            crypt_password2: "obscured-2".into(),
        }
    }

    #[test]
    fn round_trips_and_hides_the_credentials() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let code = encode(&sample(), "my-passphrase").unwrap();
        assert!(code.starts_with(PREFIX));
        assert!(!code.contains("hunter2"), "credential visible in the code");
        assert!(!code.contains("my-bucket"), "endpoint visible in the code");
        assert_eq!(decode(&code, "my-passphrase").unwrap(), sample());
    }

    #[test]
    fn the_wrong_passphrase_is_rejected_clearly() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let code = encode(&sample(), "my-passphrase").unwrap();
        let err = decode(&code, "not-the-passphrase").unwrap_err();
        assert!(err.contains("passphrase"), "unhelpful message: {err}");
    }

    #[test]
    fn survives_the_line_breaks_an_email_client_adds() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let code = encode(&sample(), "my-passphrase").unwrap();
        let mangled = code
            .chars()
            .collect::<Vec<_>>()
            .chunks(40)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\r\n");
        assert_eq!(decode(&mangled, "my-passphrase").unwrap(), sample());
    }

    #[test]
    fn rejects_junk_and_short_passphrases() {
        assert!(decode("hello", "my-passphrase").unwrap_err().contains("Vellum connection code"));
        assert!(encode(&sample(), "short").unwrap_err().contains("at least"));
        assert!(decode("VELLUM-SYNC-1:zzz", "short").unwrap_err().contains("at least"));
    }

    #[test]
    fn a_truncated_code_fails_rather_than_half_decoding() {
        if rclone::binary_path().is_err() {
            eprintln!("skipping: rclone sidecar not fetched");
            return;
        }
        let code = encode(&sample(), "my-passphrase").unwrap();
        let truncated = &code[..code.len() - 20];
        assert!(decode(truncated, "my-passphrase").is_err());
    }
}
