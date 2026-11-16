//! `updates:*` (port of the updater part of electron/main.ts) on the Tauri updater plugin.
//!
//! The updater is only active in release builds compiled with GITVERSE_UPDATER_PUBKEY (the public
//! half of the key that signs releases; see docs/rust-migration/updater.md). Without it every
//! check reports `development`, like an unpackaged Electron build.
use std::sync::Mutex;

use gitverse_core::releases::{self, ReleaseUpdate};
use gitverse_core::AppError;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::AppState;

/// Public key baked in at build time; release CI sets it from the repository variable.
pub const PUBKEY: Option<&str> = option_env!("GITVERSE_UPDATER_PUBKEY");

pub fn enabled() -> bool {
    !cfg!(debug_assertions) && PUBKEY.is_some_and(|k| !k.trim().is_empty())
}

/// The update found by the last check and, once downloaded, its verified bytes.
#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
    bytes: Mutex<Option<(String, Vec<u8>)>>,
    downloading: Mutex<bool>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

fn version(handle: &tauri::AppHandle) -> String {
    handle.package_info().version.to_string()
}

#[tauri::command]
pub fn updates_environment(handle: tauri::AppHandle) -> Value {
    json!({ "enabled": enabled(), "currentVersion": version(&handle), "manualInstall": false })
}

/// `AppUpdateCheck` (src/shared/updates.ts).
#[tauri::command]
pub async fn updates_check(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<Value, ()> {
    let current = version(&handle);
    if !enabled() {
        return Ok(json!({ "kind": "development", "currentVersion": current }));
    }
    let checked = match handle.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    Ok(match checked {
        Ok(Some(update)) => {
            let v = update.version.clone();
            *lock(&app.updates.found) = Some(update);
            json!({ "kind": "optional", "currentVersion": current, "version": v, "url": releases::tag_url(&format!("v{v}")) })
        }
        Ok(None) => json!({ "kind": "current", "currentVersion": current }),
        Err(e) => json!({ "kind": "error", "currentVersion": current, "message": e.to_string() }),
    })
}

/// The check behind the launch screen: a feed that cannot be read (no release has published
/// `latest.json` yet, offline, GitHub down) must not stop the app from opening, so it counts as
/// "no update" here. A manual check still reports the error.
#[tauri::command]
pub async fn updates_startup(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<Value, ()> {
    let result = updates_check(handle, app).await?;
    Ok(startup_view(result))
}

fn startup_view(result: Value) -> Value {
    if result["kind"] == "error" {
        json!({ "kind": "current", "currentVersion": result["currentVersion"] })
    } else {
        result
    }
}

#[tauri::command]
pub async fn updates_download(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
    version: String,
) -> Result<(), AppError> {
    let invalid = |m: &str| AppError::Invalid(m.into());
    if !enabled() {
        return Err(invalid("Updates are only available in release builds."));
    }
    let update = lock(&app.updates.found)
        .clone()
        .filter(|u| u.version == version)
        .ok_or_else(|| invalid("Check for updates again."))?;
    {
        let mut busy = lock(&app.updates.downloading);
        if *busy {
            return Err(invalid("An update is already downloading."));
        }
        *busy = true;
    }
    let emit = |status: Status| {
        let _ = handle.emit("updates:status", status);
    };
    emit(Status {
        state: "downloading",
        percent: Some(0.0),
        version: Some(version.clone()),
    });
    let mut received = 0u64;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    emit(Status {
                        state: "downloading",
                        percent: Some(received as f64 * 100.0 / total as f64),
                        version: Some(version.clone()),
                    });
                }
            },
            || {},
        )
        .await;
    *lock(&app.updates.downloading) = false;
    // download() verifies the signature against the baked-in public key
    let bytes = result.map_err(|e| AppError::Invalid(e.to_string()))?;
    *lock(&app.updates.bytes) = Some((version.clone(), bytes));
    emit(Status {
        state: "downloaded",
        percent: None,
        version: Some(version),
    });
    Ok(())
}

#[tauri::command]
pub fn updates_install(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let update = lock(&app.updates.found).clone();
    let bytes = lock(&app.updates.bytes).take();
    let (Some(update), Some((v, bytes))) = (update, bytes) else {
        return Err(AppError::Invalid("Download an update first.".into()));
    };
    if update.version != v {
        return Err(AppError::Invalid("Download an update first.".into()));
    }
    update
        .install(bytes)
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    // Windows: the installer has already taken over; macOS/Linux: the bundle was replaced in place
    handle.restart();
}

#[tauri::command]
pub async fn updates_list() -> Result<Vec<ReleaseUpdate>, AppError> {
    releases::list_releases().await.map_err(AppError::Invalid)
}

#[tauri::command]
pub fn updates_open_release_list(handle: tauri::AppHandle) -> Result<(), AppError> {
    handle
        .opener()
        .open_url(releases::RELEASES_URL, None::<&str>)
        .map_err(|e| AppError::Invalid(e.to_string()))
}

#[tauri::command]
pub fn updates_open_downloads(handle: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if !releases::is_release_page(&url) {
        return Err(AppError::Invalid("Invalid release download URL.".into()));
    }
    handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::startup_view;
    use serde_json::json;

    #[test]
    fn startup_never_reports_a_feed_error() {
        let failed = json!({ "kind": "error", "currentVersion": "1.0.0", "message": "Could not fetch a valid release JSON from the remote" });
        assert_eq!(
            startup_view(failed),
            json!({ "kind": "current", "currentVersion": "1.0.0" })
        );
        let found = json!({ "kind": "optional", "currentVersion": "1.0.0", "version": "1.1.0", "url": "u" });
        assert_eq!(startup_view(found.clone()), found);
    }
}
