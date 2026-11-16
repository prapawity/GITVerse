//! Secrets (API keys, tokens) in the OS credential store: Keychain on macOS, Credential Manager
//! on Windows, Secret Service on Linux. Replaces Electron's safeStorage, whose ciphertext lived in
//! the state file. Key names are the same as before (e.g. `ai.apiKey`), but Electron-encrypted
//! values cannot be decrypted outside Electron, so users enter keys once more after switching.
use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, Result};

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    /// `None` deletes the secret.
    fn set(&self, key: &str, value: Option<&str>) -> Result<()>;
    /// Whether secrets can be stored safely on this system (`canEncrypt` in the UI).
    fn available(&self) -> bool;
}

pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &str) -> std::result::Result<keyring::Entry, keyring::Error> {
        keyring::Entry::new(&self.service, key)
    }
}

const NO_STORAGE: &str =
    "This system has no secure storage, so the secret cannot be saved safely. Use an environment variable instead.";

impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Option<String> {
        self.entry(key).ok()?.get_password().ok()
    }

    fn set(&self, key: &str, value: Option<&str>) -> Result<()> {
        let entry = self
            .entry(key)
            .map_err(|_| AppError::Invalid(NO_STORAGE.into()))?;
        match value {
            Some(v) => entry.set_password(v).map_err(|e| match e {
                keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
                    AppError::Invalid(NO_STORAGE.into())
                }
                other => AppError::Invalid(format!("Could not save the secret: {other}")),
            }),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(AppError::Invalid(format!(
                    "Could not remove the secret: {e}"
                ))),
            },
        }
    }

    fn available(&self) -> bool {
        // A lookup of a missing entry succeeds with NoEntry when the store itself works.
        matches!(
            self.entry("gitverse.probe").map(|e| e.get_password()),
            Ok(Ok(_)) | Ok(Err(keyring::Error::NoEntry))
        )
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }
    fn set(&self, key: &str, value: Option<&str>) -> Result<()> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match value {
            Some(v) => map.insert(key.to_owned(), v.to_owned()),
            None => map.remove(key),
        };
        Ok(())
    }
    fn available(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip through the real OS store; skipped where there is none (e.g. headless Linux CI).
    #[test]
    fn keychain_round_trip() {
        let store = Keychain::new("io.github.prapawity.gitverse.test");
        if !store.available() {
            eprintln!("no OS credential store here; skipping");
            return;
        }
        let key = format!("roundtrip.{}", std::process::id());
        store.set(&key, Some("sk-ไทย-✓")).unwrap();
        assert_eq!(store.get(&key).as_deref(), Some("sk-ไทย-✓"));
        store.set(&key, None).unwrap();
        assert_eq!(store.get(&key), None);
        store.set(&key, None).unwrap(); // deleting a missing secret is fine
    }
}
