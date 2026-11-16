//! One-time import of the secrets the Electron build saved, so users switching to the Tauri build
//! keep their API keys, sign-ins and push tokens.
//!
//! Electron's `safeStorage` stored them base64-encoded in `gitverse-state.json`, encrypted with
//! Chromium's os_crypt scheme:
//!  - Windows: `v10` + 12-byte nonce + AES-256-GCM; the key is in `Local State`
//!    (`os_crypt.encrypted_key`, "DPAPI" + a DPAPI blob for the current user).
//!  - macOS: `v10` + AES-128-CBC (IV of 16 spaces), key = PBKDF2-SHA1(password, "saltysalt", 1003)
//!    with the password from the Keychain item "GITVerse Safe Storage".
//!  - Linux: `v10` with the fixed password "peanuts" (1 iteration). `v11` (a password kept in the
//!    desktop secret service) is not imported: those users enter their keys again.
//!
//! Values are copied into the OS keychain (`SecretStore`) only when the keychain has no value yet;
//! the Electron entries are left in place. The import runs once (`migration.electronSecrets`).
use std::path::Path;

use crate::secrets::SecretStore;
use crate::state::{load_state, save_key};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

pub const DONE: &str = "migration.electronSecrets";
const SECRET_KEYS: [&str; 4] = [
    "ai.apiKey",
    "ai.openai.oauth",
    "ai.openai.apiKey",
    "ai.copilot.token",
];
const SECRET_PREFIX: &str = "push.token.";
/// Saved in plain text by Electron; kept in the keychain by the Tauri build.
const PLAIN_KEYS: [&str; 2] = ["ai.openai.hostId", "ai.openai.clientId"];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub imported: Vec<String>,
    pub failed: Vec<String>,
}

/// Decrypts one Electron `safeStorage` value (already base64-decoded).
pub trait Decrypt {
    fn decrypt(&self, data: &[u8]) -> Option<String>;
}

pub fn migrate_electron_secrets(
    data_dir: &Path,
    secrets: &dyn SecretStore,
    decrypt: &dyn Decrypt,
) -> Report {
    let state = load_state(data_dir);
    let mut report = Report::default();
    if state.contains_key(DONE) || !secrets.available() {
        return report;
    }
    for (key, value) in &state {
        if secrets.get(key).is_some() {
            continue;
        }
        let plain = if PLAIN_KEYS.contains(&key.as_str()) {
            Some(value.clone())
        } else if SECRET_KEYS.contains(&key.as_str()) || key.starts_with(SECRET_PREFIX) {
            STANDARD
                .decode(value)
                .ok()
                .and_then(|b| decrypt.decrypt(&b))
        } else {
            continue;
        };
        match plain.filter(|p| !p.is_empty()) {
            Some(p) if secrets.set(key, Some(&p)).is_ok() => report.imported.push(key.clone()),
            _ => report.failed.push(key.clone()),
        }
    }
    let _ = save_key(data_dir, DONE, Some("1"));
    report
}

/// AES-128-CBC with PKCS#7 and the fixed IV Chromium uses on macOS and Linux.
#[cfg_attr(windows, allow(dead_code))]
fn cbc_decrypt(password: &[u8], iterations: u32, data: &[u8]) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = data.strip_prefix(b"v10")?;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
    let out = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .ok()?;
    String::from_utf8(out).ok()
}

/// AES-256-GCM with the `v10` + nonce layout Chromium uses on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
fn gcm_decrypt(key: &[u8; 32], data: &[u8]) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let body = data.strip_prefix(b"v10")?;
    if body.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = body.split_at(12);
    let out = aes_gcm::Aes256Gcm::new(key.into())
        .decrypt(nonce.into(), ct)
        .ok()?;
    String::from_utf8(out).ok()
}

/// The decryptor for this OS, reading what it needs from Electron's data folder.
pub struct ElectronSafeStorage {
    #[cfg_attr(not(windows), allow(dead_code))]
    gcm_key: Option<[u8; 32]>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    mac_password: Option<Vec<u8>>,
}

impl ElectronSafeStorage {
    pub fn for_data_dir(data_dir: &Path) -> Self {
        let _ = data_dir;
        Self {
            #[cfg(windows)]
            gcm_key: windows_key(data_dir),
            #[cfg(not(windows))]
            gcm_key: None,
            #[cfg(target_os = "macos")]
            mac_password: mac_password(),
            #[cfg(not(target_os = "macos"))]
            mac_password: None,
        }
    }
}

impl Decrypt for ElectronSafeStorage {
    fn decrypt(&self, data: &[u8]) -> Option<String> {
        #[cfg(windows)]
        return gcm_decrypt(self.gcm_key.as_ref()?, data);
        #[cfg(target_os = "macos")]
        return cbc_decrypt(self.mac_password.as_deref()?, 1003, data);
        #[cfg(all(unix, not(target_os = "macos")))]
        return cbc_decrypt(b"peanuts", 1, data);
        #[allow(unreachable_code)]
        None
    }
}

/// `Local State` → `os_crypt.encrypted_key` → strip "DPAPI" → CryptUnprotectData.
#[cfg(windows)]
fn windows_key(data_dir: &Path) -> Option<[u8; 32]> {
    use serde_json::Value;
    let local: Value =
        serde_json::from_str(&std::fs::read_to_string(data_dir.join("Local State")).ok()?).ok()?;
    let blob = STANDARD
        .decode(local["os_crypt"]["encrypted_key"].as_str()?)
        .ok()?;
    let key = dpapi_unprotect(blob.strip_prefix(b"DPAPI")?)?;
    key.try_into().ok()
}

#[cfg(windows)]
pub fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points at `data` for the call; output is allocated by the OS and freed below.
    unsafe {
        if CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        ) == 0
        {
            return None;
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Some(out)
    }
}

#[cfg(windows)]
pub fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: as in dpapi_unprotect.
    unsafe {
        if CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        ) == 0
        {
            return None;
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Some(out)
    }
}

/// Electron names the Keychain item after the app; older versions used "<name> Key" as account.
#[cfg(target_os = "macos")]
fn mac_password() -> Option<Vec<u8>> {
    ["GITVerse Key", "GITVerse"].iter().find_map(|account| {
        keyring::Entry::new("GITVerse Safe Storage", account)
            .ok()?
            .get_password()
            .ok()
            .map(String::into_bytes)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    fn cbc_encrypt(password: &[u8], iterations: u32, text: &str) -> Vec<u8> {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
        let ct = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
            .encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes());
        [b"v10".as_slice(), &ct].concat()
    }

    fn gcm_encrypt(key: &[u8; 32], text: &str) -> Vec<u8> {
        use aes_gcm::aead::{Aead, KeyInit};
        let nonce = [7u8; 12];
        let ct = aes_gcm::Aes256Gcm::new(key.into())
            .encrypt((&nonce).into(), text.as_bytes())
            .unwrap();
        [b"v10".as_slice(), &nonce, &ct].concat()
    }

    struct Peanuts;
    impl Decrypt for Peanuts {
        fn decrypt(&self, data: &[u8]) -> Option<String> {
            cbc_decrypt(b"peanuts", 1, data)
        }
    }

    #[test]
    fn decrypts_chromium_formats() {
        assert_eq!(
            cbc_decrypt(b"pw", 1003, &cbc_encrypt(b"pw", 1003, "sk-ant")).as_deref(),
            Some("sk-ant")
        );
        assert_eq!(
            cbc_decrypt(b"other", 1003, &cbc_encrypt(b"pw", 1003, "sk-ant")),
            None
        );
        let key = [3u8; 32];
        assert_eq!(
            gcm_decrypt(&key, &gcm_encrypt(&key, "gho_x")).as_deref(),
            Some("gho_x")
        );
        assert_eq!(gcm_decrypt(&[4u8; 32], &gcm_encrypt(&key, "gho_x")), None);
        assert_eq!(gcm_decrypt(&key, b"v11short"), None);
    }

    #[test]
    fn imports_once_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let enc = |t: &str| STANDARD.encode(cbc_encrypt(b"peanuts", 1, t));
        let state = serde_json::json!({
            "ai.apiKey": enc("sk-ant"),
            "push.token.abc": enc("ghp_1"),
            "ai.openai.apiKey": enc("sk-new"),
            "ai.copilot.token": "not base64 !!",
            "ai.openai.clientId": "app_1",
            "tabs": "[]",
        });
        std::fs::write(dir.path().join("gitverse-state.json"), state.to_string()).unwrap();
        let store = MemoryStore::default();
        store.set("ai.openai.apiKey", Some("sk-kept")).unwrap();

        let mut r = migrate_electron_secrets(dir.path(), &store, &Peanuts);
        r.imported.sort();
        assert_eq!(
            r.imported,
            ["ai.apiKey", "ai.openai.clientId", "push.token.abc"]
        );
        assert_eq!(r.failed, ["ai.copilot.token"]);
        assert_eq!(store.get("ai.apiKey").as_deref(), Some("sk-ant"));
        assert_eq!(store.get("push.token.abc").as_deref(), Some("ghp_1"));
        assert_eq!(store.get("ai.openai.apiKey").as_deref(), Some("sk-kept"));
        assert!(store.get("tabs").is_none());
        // marked done: a second run does nothing
        store.set("ai.apiKey", None).unwrap();
        assert_eq!(
            migrate_electron_secrets(dir.path(), &store, &Peanuts),
            Report::default()
        );
        assert!(store.get("ai.apiKey").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_key_comes_from_local_state_via_dpapi() {
        let dir = tempfile::tempdir().unwrap();
        let key = [9u8; 32];
        let blob = [b"DPAPI".as_slice(), &dpapi_protect(&key).unwrap()].concat();
        let local = serde_json::json!({ "os_crypt": { "encrypted_key": STANDARD.encode(blob) } });
        std::fs::write(dir.path().join("Local State"), local.to_string()).unwrap();
        let storage = ElectronSafeStorage::for_data_dir(dir.path());
        assert_eq!(
            storage.decrypt(&gcm_encrypt(&key, "sk-win")).as_deref(),
            Some("sk-win")
        );
    }
}
