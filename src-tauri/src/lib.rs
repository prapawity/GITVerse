//! Tauri shell for GITVerse. Commands here are thin: argument decoding + calls into gitverse-core.
//! The TS side is src/platform/tauri.ts; method names match the Electron `git:<name>` channels.
mod ai_commands;
mod app_commands;
mod commands;
mod update_commands;

use std::path::PathBuf;

use gitverse_core::git::{GitRunner, Identity, IndexHistory};
use tauri::Manager;

pub struct AppState {
    pub git: GitRunner,
    /// Undo/redo of stage actions, per repository, for this app session.
    pub index_history: IndexHistory,
    /// Open integrated terminals; all are killed when the app exits.
    pub terminals: gitverse_core::terminal::Terminals,
    /// API keys and tokens, in the OS credential store.
    pub secrets: std::sync::Arc<dyn gitverse_core::secrets::SecretStore>,
    pub ai_requests: ai_commands::AiRequests,
    pub openai: std::sync::Arc<gitverse_core::ai::openai::Shared>,
    pub copilot: std::sync::Arc<gitverse_core::ai::copilot::Copilot>,
    pub scans: app_commands::Scans,
    pub updates: update_commands::Updates,
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
        .plugin(match update_commands::PUBKEY {
            Some(key) => tauri_plugin_updater::Builder::new().pubkey(key.trim()).build(),
            None => tauri_plugin_updater::Builder::new().build(),
        })
        .setup(|app| {
            let data_dir = app.path().config_dir()?.join("GITVerse");
            let git = GitRunner::default();
            git.set_identity(saved_identity(&data_dir));
            let secrets: std::sync::Arc<dyn gitverse_core::secrets::SecretStore> =
                std::sync::Arc::new(gitverse_core::secrets::Keychain::new(
                    "io.github.prapawity.gitverse",
                ));
            let copilot = ai_commands::copilot_client(app.handle(), secrets.clone());
            app.manage(AppState {
                git,
                index_history: IndexHistory::default(),
                terminals: Default::default(),
                secrets,
                ai_requests: Default::default(),
                openai: Default::default(),
                copilot: std::sync::Arc::new(copilot),
                scans: Default::default(),
                updates: Default::default(),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::state_load,
            commands::state_save,
            commands::repo_open,
            commands::set_identity,
            commands::git_call,
            commands::ported_git_methods,
            commands::repo_clone,
            commands::push_branch,
            commands::push_choose_key,
            commands::term_spawn,
            commands::term_write,
            commands::term_resize,
            commands::term_kill,
            update_commands::updates_environment,
            update_commands::updates_check,
            update_commands::updates_download,
            update_commands::updates_install,
            update_commands::updates_list,
            update_commands::updates_open_release_list,
            update_commands::updates_open_downloads,
            app_commands::repo_find_repositories,
            app_commands::repo_cancel_scan,
            app_commands::repo_open_file,
            app_commands::app_open_third_party_notices,
            app_commands::app_open_runtime_notice,
            ai_commands::ai_status,
            ai_commands::ai_copilot_status,
            ai_commands::ai_set_key,
            ai_commands::ai_models,
            ai_commands::ai_copilot_begin_login,
            ai_commands::ai_copilot_advance_login,
            ai_commands::ai_copilot_cancel_login,
            ai_commands::ai_openai_sign_in,
            ai_commands::ai_openai_cancel,
            ai_commands::ai_openai_sign_out,
            ai_commands::ai_turn,
            ai_commands::ai_abort,
            ai_commands::ai_tool_result,
            ai_commands::ai_reset,
            ai_commands::ai_commit_message,
            ai_commands::ai_resolve_conflict,
            ai_commands::push_token_status,
            ai_commands::push_set_token,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GITVerse")
        .run(|handle, event| {
            // No orphaned shells: end every terminal when the app exits.
            if let tauri::RunEvent::Exit = event {
                handle.state::<AppState>().terminals.kill_all();
                handle.state::<AppState>().copilot.shutdown();
            }
        });
}
