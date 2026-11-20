use std::path::{Path, PathBuf};

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
pub const PORTED: &[&str] = &[
    "status",
    "log",
    "refs",
    "reflog",
    "historyPosition",
    "commitDetail",
    "commitFileDiff",
    "workingFileDiff",
    "fileChangeCounts",
    "fileBlame",
    "fileHistory",
    "opState",
    // phase 3, batch A (write side)
    "stage",
    "unstage",
    "commit",
    "checkout",
    "renameBranch",
    "lfsStatus",
    "lfsAction",
    "submodules",
    "submoduleUpdate",
    "worktreeRemove",
    "worktreeLock",
    "applyPatch",
    "rangeFiles",
    "rangeFileDiff",
    "rangePatch",
    "externalTool",
    "externalToolConfig",
    "setExternalToolConfig",
    "maintenance",
    "pushTag",
    "deleteTag",
    "addRemote",
    "removeRemote",
    "ignorePath",
    "commitTemplate",
    "signingConfig",
    "setSigningConfig",
    "createBranch",
    "branchAt",
    "deleteBranch",
    "deleteRemoteBranch",
    "stash",
    "stashPop",
    "stashAction",
    "stashRename",
    "stashDetail",
    "stashDiff",
    "reset",
    "cherryPick",
    "revert",
    "rebaseOnto",
    "merge",
    "opContinue",
    "opAbort",
    "opSkip",
    "resolveFile",
    "createTag",
    "createAnnotatedTag",
    "tagCommit",
    "fileAt",
    "formatPatch",
    "remoteUrl",
    "commitIdentity",
    "setCommitIdentity",
    "fetch",
    "pull",
    "push",
    "readWorkFile",
    "writeWorkFile",
    "windowsUnsupportedPathsForRef",
    // phase 3, batch B
    "stagedForCommitMessage",
    "checkoutRemote",
    "trackedStage",
    "indexUndoState",
    "moveIndexHistory",
    "stageWorkingHunk",
    "discardWorkingHunk",
    "discardWorkingFiles",
    "squashCommits",
    "cherryPickMany",
    "stashFileDiff",
    "stashFileAt",
    "rebasePreview",
    "fileBlobAt",
    "workingFileBlob",
    "worktreeAdd",
    "inspectWorkspace",
    "agentCheckpoints",
    "pushInfo",
];

#[tauri::command]
pub fn ported_git_methods() -> Vec<&'static str> {
    PORTED.to_vec()
}

/// Positional arguments exactly as the renderer passes them to `git:<name>`.
struct Args(Vec<Value>);

impl Args {
    fn repo(&self) -> CmdResult<PathBuf> {
        self.str(0).map(PathBuf::from)
    }
    fn str(&self, i: usize) -> CmdResult<&str> {
        self.opt_str(i)
            .ok_or_else(|| AppError::Invalid(format!("Argument {i} must be a non-empty string.")))
    }
    fn opt_str(&self, i: usize) -> Option<&str> {
        self.0
            .get(i)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }
    fn u64_or(&self, i: usize, default: u64) -> CmdResult<u64> {
        match self.0.get(i) {
            None | Some(Value::Null) => Ok(default),
            Some(v) => v
                .as_u64()
                .ok_or_else(|| AppError::Invalid(format!("Argument {i} must be a whole number."))),
        }
    }
    fn i64(&self, i: usize) -> CmdResult<i64> {
        self.0.get(i).and_then(Value::as_i64).ok_or_else(|| {
            AppError::Invalid("This hunk is no longer available. Refresh the diff.".into())
        })
    }
    fn bool_or(&self, i: usize, default: bool) -> bool {
        self.0.get(i).and_then(Value::as_bool).unwrap_or(default)
    }
    fn strings(&self, i: usize) -> CmdResult<Vec<String>> {
        self.parse(i)
    }
    /// Optional enum/struct argument: missing or null means the TS default.
    fn parse_or_default<T: serde::de::DeserializeOwned + Default>(&self, i: usize) -> CmdResult<T> {
        match self.0.get(i) {
            None | Some(Value::Null) => Ok(T::default()),
            Some(_) => self.parse(i),
        }
    }
    fn parse<T: serde::de::DeserializeOwned>(&self, i: usize) -> CmdResult<T> {
        serde_json::from_value(self.0.get(i).cloned().unwrap_or(Value::Null))
            .map_err(|e| AppError::Invalid(format!("Argument {i}: {e}")))
    }
}

fn json<T: serde::Serialize>(value: T) -> CmdResult<Value> {
    Ok(serde_json::to_value(value)?)
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
    let history = &app.index_history;
    let a = Args(args);
    match method.as_str() {
        "status" => json(git::status(&git, &a.repo()?).await?),
        "log" => json(
            git::log_scoped(
                &git,
                &a.repo()?,
                a.u64_or(1, 400)?,
                a.u64_or(2, 0)?,
                a.opt_str(3).unwrap_or("topo"),
                &a.parse_or_default::<git::HistoryScope>(4)?,
            )
            .await?,
        ),
        "refs" => json(git::refs(&git, &a.repo()?).await?),
        "reflog" => json(git::reflog(&git, &a.repo()?).await?),
        "historyPosition" => json(
            git::history_position_scoped(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.opt_str(2).unwrap_or("topo"),
                &a.parse_or_default::<git::HistoryScope>(3)?,
            )
            .await?,
        ),
        "lfsStatus" => json(git::lfs_status(&git, &a.repo()?).await?),
        "lfsAction" => json(git::lfs_action(&git, &a.repo()?, a.str(1)?, a.opt_str(2)).await?),
        "submodules" => json(git::submodules(&git, &a.repo()?).await?),
        "submoduleUpdate" => json(git::submodule_update(&git, &a.repo()?, a.opt_str(1)).await?),
        "worktreeRemove" => json(
            git::worktree_remove(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.bool_or(2, false),
                a.opt_str(3),
            )
            .await?,
        ),
        "worktreeLock" => {
            json(git::worktree_lock(&git, &a.repo()?, a.str(1)?, a.bool_or(2, true)).await?)
        }
        "applyPatch" => json(git::apply_patch(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "rangeFiles" => json(git::range_files(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "rangeFileDiff" => json(
            git::range_file_diff(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.str(2)?,
                a.str(3)?,
                a.opt_str(4),
            )
            .await?,
        ),
        "rangePatch" => json(git::range_patch(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "externalTool" => json(
            git::external_tool(&git, &a.repo()?, a.str(1)?, a.str(2)?, a.bool_or(3, false)).await?,
        ),
        "externalToolConfig" => json(git::external_tool_config(&git, &a.repo()?).await?),
        "setExternalToolConfig" => {
            json(git::set_external_tool_config(&git, &a.repo()?, a.parse(1)?).await?)
        }
        "maintenance" => json(git::maintenance(&git, &a.repo()?).await?),
        "renameBranch" => json(git::rename_branch(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "pushTag" => json(git::push_tag(&git, &a.repo()?, a.str(1)?, a.opt_str(2)).await?),
        "deleteTag" => json(git::delete_tag(&git, &a.repo()?, a.str(1)?, a.opt_str(2)).await?),
        "addRemote" => json(git::add_remote(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "removeRemote" => json(git::remove_remote(&git, &a.repo()?, a.str(1)?).await?),
        "ignorePath" => json(git::ignore_path(&git, &a.repo()?, a.str(1)?, a.opt_str(2)).await?),
        "commitTemplate" => json(git::commit_template(&git, &a.repo()?).await?),
        "signingConfig" => json(git::signing_config(&git, &a.repo()?).await?),
        "setSigningConfig" => {
            json(git::set_signing_config(&git, &a.repo()?, a.parse(1)?, a.str(2)?).await?)
        }
        "commitDetail" => json(git::commit_detail(&git, &a.repo()?, a.str(1)?).await?),
        "commitFileDiff" => {
            json(git::commit_file_diff(&git, &a.repo()?, a.str(1)?, a.str(2)?, a.opt_str(3)).await?)
        }
        "workingFileDiff" => {
            json(git::working_file_diff(&git, &a.repo()?, a.str(1)?, a.parse(2)?).await?)
        }
        "fileChangeCounts" => json(git::file_change_counts(&git, &a.repo()?).await?),
        "fileBlame" => json(git::file_blame(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "fileHistory" => json(git::file_history(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "opState" => json(git::op_state(&git, &a.repo()?).await?),
        "stage" => json(git::stage(&git, &a.repo()?, &a.strings(1)?).await?),
        "unstage" => json(git::unstage(&git, &a.repo()?, &a.strings(1)?).await?),
        "commit" => json(
            git::commit(
                &git,
                &a.repo()?,
                a.opt_str(1).unwrap_or(""),
                a.opt_str(2).unwrap_or(""),
                a.parse_or_default(3)?,
            )
            .await?,
        ),
        "checkout" => json(git::checkout(&git, &a.repo()?, a.str(1)?).await?),
        "createBranch" => {
            json(git::create_branch(&git, &a.repo()?, a.str(1)?, a.opt_str(2)).await?)
        }
        "branchAt" => json(git::branch_at(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "deleteBranch" => {
            json(git::delete_branch(&git, &a.repo()?, a.str(1)?, a.bool_or(2, false)).await?)
        }
        "deleteRemoteBranch" => json(git::delete_remote_branch(&git, &a.repo()?, a.str(1)?).await?),
        "stash" => json(git::stash(&git, &a.repo()?, a.opt_str(1)).await?),
        "stashPop" => json(git::stash_pop(&git, &a.repo()?).await?),
        "stashAction" => json(git::stash_action(&git, &a.repo()?, a.str(1)?, a.parse(2)?).await?),
        "stashRename" => {
            json(git::stash_rename(&git, &a.repo()?, a.str(1)?, a.opt_str(2).unwrap_or("")).await?)
        }
        "stashDetail" => json(git::stash_detail(&git, &a.repo()?, a.str(1)?).await?),
        "stashDiff" => json(git::stash_diff(&git, &a.repo()?, a.str(1)?).await?),
        "reset" => json(git::reset(&git, &a.repo()?, a.str(1)?, a.parse(2)?).await?),
        "cherryPick" => json(git::cherry_pick(&git, &a.repo()?, a.str(1)?).await?),
        "revert" => json(git::revert(&git, &a.repo()?, a.str(1)?).await?),
        "rebaseOnto" => json(git::rebase_onto(&git, &a.repo()?, a.str(1)?).await?),
        "merge" => json(
            git::merge(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.bool_or(2, true),
                a.bool_or(3, false),
            )
            .await?,
        ),
        "opContinue" => json(git::op_continue(&git, &a.repo()?, a.parse(1)?, a.opt_str(2)).await?),
        "opAbort" => json(git::op_abort(&git, &a.repo()?, a.parse(1)?).await?),
        "opSkip" => json(git::op_skip(&git, &a.repo()?, a.parse(1)?).await?),
        "resolveFile" => json(git::resolve_file(&git, &a.repo()?, a.str(1)?, a.parse(2)?).await?),
        "createTag" => json(git::create_tag(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "createAnnotatedTag" => json(
            git::create_annotated_tag(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.str(2)?,
                a.opt_str(3).unwrap_or(""),
            )
            .await?,
        ),
        "tagCommit" => json(git::tag_commit(&git, &a.repo()?, a.opt_str(1).unwrap_or("")).await?),
        "fileAt" => json(git::file_at(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "formatPatch" => json(git::format_patch(&git, &a.repo()?, a.str(1)?).await?),
        "remoteUrl" => json(git::remote_url(&git, &a.repo()?).await?),
        "commitIdentity" => json(git::commit_identity(&git, &a.repo()?).await?),
        "setCommitIdentity" => json(
            git::set_commit_identity(
                &git,
                &a.repo()?,
                a.opt_str(1).unwrap_or(""),
                a.opt_str(2).unwrap_or(""),
            )
            .await?,
        ),
        "fetch" => json(git::fetch(&git, &a.repo()?, a.bool_or(1, true)).await?),
        "pull" => json(git::pull(&git, &a.repo()?, a.parse_or_default(1)?).await?),
        "push" => json(git::push(&git, &a.repo()?).await?),
        "readWorkFile" => json(git::read_work_file(&a.repo()?, a.str(1)?)?),
        "writeWorkFile" => json(git::write_work_file(
            &a.repo()?,
            a.str(1)?,
            a.opt_str(2).unwrap_or(""),
        )?),
        "stagedForCommitMessage" => json(git::staged_for_commit_message(&git, &a.repo()?).await?),
        "checkoutRemote" => {
            let expected: Option<Vec<String>> = a.parse_or_default(3)?;
            json(
                git::checkout_remote(
                    &git,
                    &a.repo()?,
                    a.str(1)?,
                    a.bool_or(2, false),
                    expected.as_deref(),
                )
                .await?,
            )
        }
        "trackedStage" => {
            let stage = match a.str(1)? {
                "stage" => true,
                "unstage" => false,
                _ => return Err(AppError::Invalid("Invalid stage action.".into())),
            };
            json(
                history
                    .tracked_stage(&git, &a.repo()?, stage, &a.strings(2)?)
                    .await?,
            )
        }
        "indexUndoState" => json(history.state(&git, &a.repo()?).await?),
        "moveIndexHistory" => {
            let undo = match a.str(1)? {
                "undo" => true,
                "redo" => false,
                _ => return Err(AppError::Invalid("Invalid history action.".into())),
            };
            json(history.move_history(&git, &a.repo()?, undo).await?)
        }
        "stageWorkingHunk" => json(
            git::stage_working_hunk(
                &git,
                history,
                &a.repo()?,
                a.str(1)?,
                a.parse(2)?,
                a.opt_str(3).unwrap_or(""),
                a.i64(4)?,
            )
            .await?,
        ),
        "discardWorkingHunk" => json(
            git::discard_working_hunk(
                &git,
                &a.repo()?,
                a.str(1)?,
                a.opt_str(2).unwrap_or(""),
                a.i64(3)?,
            )
            .await?,
        ),
        "discardWorkingFiles" => {
            let files: Vec<git::DiscardFile> = a
                .parse(1)
                .map_err(|_| AppError::Invalid("Invalid discard selection.".into()))?;
            json(git::discard_working_files(&git, &a.repo()?, &files).await?)
        }
        "squashCommits" => json(
            git::squash_commits(&git, &a.repo()?, &a.strings(1)?, a.opt_str(2).unwrap_or(""))
                .await?,
        ),
        "cherryPickMany" => json(git::cherry_pick_many(&git, &a.repo()?, &a.strings(1)?).await?),
        "stashFileDiff" => {
            json(git::stash_file_diff(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?)
        }
        "stashFileAt" => json(git::stash_file_at(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "rebasePreview" => {
            json(git::rebase_preview(&git, &a.repo()?, a.opt_str(1).unwrap_or("")).await?)
        }
        "fileBlobAt" => json(git::file_blob_at(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "workingFileBlob" => json(git::working_file_blob(&a.repo()?, a.str(1)?)?),
        "worktreeAdd" => json(git::worktree_add(&git, &a.repo()?, a.str(1)?, a.str(2)?).await?),
        "inspectWorkspace" => json(git::inspect_workspace(&git, &a.repo()?).await?),
        "agentCheckpoints" => json(git::agent_checkpoints(&git, &a.repo()?).await?),
        "pushInfo" => json(git::push_info(&git, &a.repo()?).await?),
        "windowsUnsupportedPathsForRef" => {
            json(git::windows_unsupported_paths_for_ref(&git, &a.repo()?, a.str(1)?).await?)
        }
        other => Err(AppError::NotPorted(format!(
            "'{other}' is not available in the Tauri build yet (Rust migration in progress)."
        ))),
    }
}

// ---- integrated terminal (term:*) ----

#[derive(Clone, serde::Serialize)]
struct TermData {
    id: u32,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct TermExit {
    id: u32,
    code: i32,
}

/// `term:spawn`: output and exit arrive as `term:data` / `term:exit` events.
#[tauri::command]
pub fn term_spawn(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> CmdResult<u32> {
    use tauri::Emitter;
    let (data, exit) = (handle.clone(), handle);
    app.terminals.spawn(
        Path::new(&cwd),
        cols,
        rows,
        shell.as_deref(),
        move |id, data_text| {
            let _ = data.emit(
                "term:data",
                TermData {
                    id,
                    data: data_text,
                },
            );
        },
        move |id, code| {
            let _ = exit.emit("term:exit", TermExit { id, code });
        },
    )
}

#[tauri::command]
pub fn term_write(app: tauri::State<'_, AppState>, id: u32, data: String) -> CmdResult<()> {
    app.terminals.write(id, &data)
}

#[tauri::command]
pub fn term_resize(
    app: tauri::State<'_, AppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    app.terminals.resize(id, cols, rows)
}

#[tauri::command]
pub fn term_kill(app: tauri::State<'_, AppState>, id: u32) {
    app.terminals.kill(id);
}

/// `repo:clone`: progress lines are emitted as `repo:cloneProgress` events while git runs.
#[tauri::command]
pub async fn repo_clone(
    handle: tauri::AppHandle,
    url: String,
    destination: String,
    credentials: Option<PushCredentials>,
    depth: Option<u32>,
) -> CmdResult<()> {
    use tauri::Emitter;
    git::clone_with_options(
        &url,
        &destination,
        credentials
            .as_ref()
            .map(|c| (c.username.as_str(), c.password.as_str())),
        depth,
        |line| {
            let _ = handle.emit("repo:cloneProgress", line);
        },
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct PushProfile {
    #[serde(default)]
    pub id: String,
    pub kind: git::AuthKind,
    #[serde(default)]
    pub username: String,
    #[serde(default, rename = "sshKey")]
    pub ssh_key: String,
}

#[derive(serde::Deserialize)]
pub struct PushCredentials {
    pub username: String,
    pub password: String,
}

/// `push:branch`. Explicit credentials win; otherwise the profile's kind decides, and HTTPS
/// profiles use the token saved in the OS keychain.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn push_branch(
    app: tauri::State<'_, AppState>,
    repo: String,
    remote: String,
    branch: String,
    target: String,
    profile: Option<PushProfile>,
    credentials: Option<PushCredentials>,
    options: Option<git::PushOptions>,
) -> CmdResult<String> {
    let auth = match (credentials, profile) {
        (Some(c), _) => Some(git::PushAuth {
            kind: git::AuthKind::Https,
            username: Some(c.username),
            token: Some(c.password),
            ssh_key: None,
        }),
        (None, Some(p)) => Some(git::PushAuth {
            token: (p.kind == git::AuthKind::Https)
                .then(|| {
                    app.secrets
                        .get(&crate::ai_commands::push_token_key(&repo, &p.id))
                })
                .flatten(),
            kind: p.kind,
            username: Some(p.username).filter(|u| !u.is_empty()),
            ssh_key: Some(p.ssh_key).filter(|k| !k.is_empty()),
        }),
        (None, None) => None,
    };
    git::push_branch(
        &app.git,
        PathBuf::from(repo).as_path(),
        &remote,
        &branch,
        &target,
        auth.as_ref(),
        options.as_ref(),
    )
    .await
}

/// `push:chooseKey`: pick an SSH private key file.
#[tauri::command]
pub async fn push_choose_key(handle: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    handle
        .dialog()
        .file()
        .set_title("Choose SSH private key")
        .pick_file(move |file| {
            let _ = tx.send(file.and_then(|f| f.into_path().ok()));
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::PORTED;

    /// The Rust backend implements exactly the methods the renderer can call (src/shared/gitMethods.ts).
    #[test]
    fn ported_methods_match_the_ts_contract() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/shared/gitMethods.ts");
        let ts = std::fs::read_to_string(path).expect("read gitMethods.ts");
        let list = ts
            .split("GIT_METHODS = [")
            .nth(1)
            .and_then(|r| r.split(']').next())
            .expect("GIT_METHODS list");
        let mut expected: Vec<&str> = list
            .split(',')
            .map(|s| s.trim().trim_matches('\''))
            .filter(|s| !s.is_empty())
            .collect();
        let mut ported = PORTED.to_vec();
        expected.sort_unstable();
        ported.sort_unstable();
        assert_eq!(ported, expected, "Rust PORTED and TS GIT_METHODS differ");
    }
}
