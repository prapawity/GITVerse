//! Git operations. Mirrors `electron/git/git.ts`: every operation shells out to the system `git`
//! (same behavior, hooks, credentials and config as the user's terminal), then parses the output.
mod runner;
mod status;

pub use runner::{GitRunner, Identity, RunOpts};
pub use status::{parse_status, status, FileStatus};
