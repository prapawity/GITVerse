//! Tauri shell for GITVerse. Commands here are thin: argument decoding + calls into gitverse-core.
//! The TS side is src/platform/tauri.ts; method names match the Electron `git:<name>` channels.
mod commands;

use std::path::PathBuf;

use gitverse_core::git::{GitRunner, Identity};
use tauri::Manager;

pub struct AppState {
    pub git: GitRunner,
    /// Same folder Electron uses (`<appData>/GITVerse`), so both builds share repos and settings.
    pub data_dir: PathBuf,
}

/// Apply the saved commit identity at startup, like the top of electron/main.ts.
fn saved_identity(data_dir: &std::path::Path) -> Option<Identity> {
    let state = gitverse_core::state::load_state(data_dir);
    let settings: serde_json::Value = serde_json::from_str(state.get("gitverse.settings")?).ok()?;
    let saved = settings.get("state")?;
    let active = saved.get("activeIdentityProfile")?.as_str()?;
    let profile = saved
        .get("sharedIdentityProfiles")?
        .as_array()?
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(active))?;
    Some(Identity {
        name: profile.get("authorName")?.as_str()?.to_owned(),
        email: profile.get("email")?.as_str()?.to_owned(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().config_dir()?.join("GITVerse");
            let git = GitRunner::default();
            git.set_identity(saved_identity(&data_dir));
            app.manage(AppState { git, data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::state_load,
            commands::state_save,
            commands::repo_open,
            commands::set_identity,
            commands::git_call,
            commands::ported_git_methods,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GITVerse");
}
