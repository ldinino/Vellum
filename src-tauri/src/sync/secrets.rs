//! At-rest protection for sync credentials.
//!
//! The remote definition (endpoint, keys, and the two `crypt` passwords) is
//! stored as a single blob under `%LOCALAPPDATA%\Vellum`, never inside a
//! Satchel — it must not sync. On Windows it is sealed with DPAPI at user
//! scope, so only the same Windows user on the same machine can read it back:
//! the same protection class as Credential Manager, without an extra
//! dependency (the `windows` crate is already here for DXGI and acrylic).
//!
//! Vellum ships Windows-only for v1. The other platforms compile in CI, so they
//! get a stub that refuses rather than a weaker implementation that would
//! quietly store credentials in the clear.

/// Seal bytes so only this user on this machine can read them back.
#[cfg(windows)]
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &mut input,
            None,
            None,
            None,
            None,
            0,
            &mut output,
        )
        .map_err(|e| format!("could not protect the stored credentials: {e}"))?;
        let sealed = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(sealed)
    }
}

/// Reverse of [`protect`]. Fails if the blob was sealed by another user or on
/// another machine, which is the intended behaviour rather than an error to
/// work around.
#[cfg(windows)]
pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &mut input,
            None,
            None,
            None,
            None,
            0,
            &mut output,
        )
        .map_err(|_| {
            "The saved sync credentials can't be read on this machine or user account.".to_string()
        })?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(plain)
    }
}

#[cfg(not(windows))]
pub fn protect(_plaintext: &[u8]) -> Result<Vec<u8>, String> {
    Err("Sync credential storage is only implemented on Windows.".into())
}

#[cfg(not(windows))]
pub fn unprotect(_sealed: &[u8]) -> Result<Vec<u8>, String> {
    Err("Sync credential storage is only implemented on Windows.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_conceals_the_plaintext() {
        let secret = b"vellum-b2:bucket/path + hunter2";
        let sealed = protect(secret).unwrap();
        assert_ne!(sealed.as_slice(), secret.as_slice());
        // The blob must not carry the secret in the clear.
        assert!(
            sealed
                .windows(secret.len())
                .all(|w| w != secret.as_slice()),
            "plaintext survived in the sealed blob"
        );
        assert_eq!(unprotect(&sealed).unwrap(), secret.to_vec());
    }

    #[test]
    fn refuses_a_corrupted_blob() {
        let mut sealed = protect(b"something").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert!(unprotect(&sealed).is_err());
    }

    #[test]
    fn handles_empty_input() {
        let sealed = protect(b"").unwrap();
        assert_eq!(unprotect(&sealed).unwrap(), Vec::<u8>::new());
    }
}
