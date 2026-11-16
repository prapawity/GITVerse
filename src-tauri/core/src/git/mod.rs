//! Git operations. Mirrors `electron/git/git.ts`: every operation shells out to the system `git`
//! (same behavior, hooks, credentials and config as the user's terminal), then parses the output.
mod blame;
mod counts;
mod log;
mod op_state;
mod reflog;
mod refs;
mod runner;
mod show;
mod stash;
mod status;
mod windows;
mod write;

pub use blame::{file_blame, file_history, BlameLine, FileHistoryEntry};
pub use counts::{file_change_counts, FileChangeCount};
pub use log::{history_position, log, parse_refs, Commit, RefKind, RefLabel};
pub use op_state::{op_state, OpKind, OpState};
pub use reflog::{reflog, ReflogEntry};
pub use refs::{refs, stash_entries, RefList, StashRef};
pub use runner::{GitRunner, Identity, RunOpts};
pub use show::{
    commit_detail, commit_file_diff, working_file_diff, Area, ChangedFile, CommitDetail,
};
pub use stash::{
    stash, stash_action, stash_detail, stash_diff, stash_pop, stash_rename, StashDetail, StashOp,
};
pub use status::{parse_status, status, FileStatus};
pub use windows::{windows_incompatible_paths, windows_unsupported_paths_for_ref};
pub use write::*;
