use std::path::PathBuf;

use gitverse_core::git::{self, Identity};
use gitverse_core::state::{self, State};
use gitverse_core::AppError;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;

use crate::AppState;

type CmdResult<T> = Result<T, AppError>;

#[tauri::command]
pub fn state_load(app: tauri::State<'_, AppState>) -> State {
    state::load_state(&app.data_dir)
}

#[tauri::command]
pub fn state_save(
    app: tauri::State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> CmdResult<()> {
    state::save_key(&app.data_dir, &key, value.as_deref())
}

/// Folder picker for "Open repository"; `None` when the user cancels (same as `repo:open`).
#[tauri::command]
pub async fn repo_open(handle: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    handle.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.and_then(|f| f.into_path().ok()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn set_identity(app: tauri::State<'_, AppState>, identity: Option<Identity>) {
    app.git.set_identity(identity);
}

/// Git methods implemented in Rust so far. The TS adapter uses this to report "not ported yet"
/// clearly; tests compare it against src/shared/gitMethods.ts as the port progresses.
pub const PORTED: &[&str] = &["status"];

#[tauri::command]
pub fn ported_git_methods() -> Vec<&'static str> {
    PORTED.to_vec()
}

fn arg_path(args: &[Value], i: usize) -> CmdResult<PathBuf> {
    args.get(i)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Invalid(format!("Argument {i} must be a repository path.")))
}

/// One entry point for every `git:<name>` call, mirroring Electron's handler table, so the renderer
/// keeps calling methods by name while operations move to Rust one at a time.
#[tauri::command]
pub async fn git_call(
    app: tauri::State<'_, AppState>,
    method: String,
    args: Vec<Value>,
) -> CmdResult<Value> {
    let git = app.git.clone();
    match method.as_str() {
        "status" => Ok(serde_json::to_value(
            git::status(&git, &arg_path(&args, 0)?).await?,
        )?),
        other => Err(AppError::NotPorted(format!(
            "'{other}' is not available in the Tauri build yet (Rust migration in progress)."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::PORTED;

    /// Every Rust-ported method must be one the renderer can call (src/shared/gitMethods.ts).
    #[test]
    fn ported_methods_exist_in_the_ts_contract() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/shared/gitMethods.ts");
        let ts = std::fs::read_to_string(path).expect("read gitMethods.ts");
        for method in PORTED {
            assert!(
                ts.contains(&format!("'{method}',")),
                "{method} is not in GIT_METHODS"
            );
        }
    }
}
