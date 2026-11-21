//! Git operations. Mirrors `electron/git/git.ts`: every operation shells out to the system `git`
//! (same behavior, hooks, credentials and config as the user's terminal), then parses the output.
mod blame;
mod checkout_remote;
mod clone;
mod counts;
mod extras;
mod hunks;
mod index_history;
mod inspect;
mod log;
mod manage;
mod misc;
mod op_state;
mod push;
mod reflog;
mod refs;
mod runner;
mod show;
mod stash;
mod status;
mod windows;
mod write;

pub use blame::{file_blame, file_history, BlameLine, FileHistoryEntry};
pub use checkout_remote::checkout_remote;
pub use clone::{clone, clone_with_credentials, clone_with_options, validate_clone_url};
pub use counts::{file_change_counts, FileChangeCount};
pub use extras::*;
pub use hunks::{discard_working_files, discard_working_hunk, stage_working_hunk, DiscardFile};
pub use index_history::{IndexHistory, UndoState};
pub use inspect::{display_url, inspect_workspace, Workspace};
pub use log::{
    history_position, history_position_scoped, history_position_sorted, log, log_scoped,
    log_sorted, parse_refs, Commit, RefKind, RefLabel,
};
pub use manage::*;
pub use misc::*;
pub use op_state::{op_state, OpKind, OpState};
pub use push::{push_branch, push_info, AuthKind, PushAuth, PushInfo, PushOptions};
pub use reflog::{reflog, ReflogEntry};
pub use refs::{refs, stash_entries, RefList, StashRef};
pub use runner::{GitRunner, Identity, RunOpts};
pub use show::{
    commit_detail, commit_file_diff, commit_people, working_file_diff, Area, ChangedFile,
    CommitDetail, CommitPeople, Person,
};
pub use stash::{
    stash, stash_action, stash_detail, stash_diff, stash_pop, stash_rename, StashDetail, StashOp,
};
pub use status::{parse_status, status, FileStatus};
pub use windows::{windows_incompatible_paths, windows_unsupported_paths_for_ref};
pub use write::*;

/// Values placed where git parses options must not look like one (e.g. `--upload-pack=…`).
pub(crate) fn not_option(label: &str, value: &str) -> crate::error::Result<()> {
    if value.is_empty() || value.starts_with('-') || value.contains('\0') {
        return Err(crate::error::AppError::Invalid(format!("Invalid {label}.")));
    }
    Ok(())
}
