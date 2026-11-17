//! Port of electron/git/reflog.ts.
use std::path::Path;

use serde::Serialize;

use super::log::{is_object_id, F, R};
use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReflogEntry {
    pub hash: String,
    pub selector: String,
    pub message: String,
}

pub fn parse_reflog(out: &str) -> Vec<ReflogEntry> {
    out.split(R)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.splitn(3, F);
            let entry = ReflogEntry {
                hash: f.next().unwrap_or_default().to_owned(),
                selector: f.next().unwrap_or_default().to_owned(),
                message: f.next().unwrap_or_default().to_owned(),
            };
            is_object_id(&entry.hash).then_some(entry)
        })
        .collect()
}

/// The current worktree's HEAD history, read without taking optional locks.
pub async fn reflog(git: &GitRunner, cwd: &Path) -> Result<Vec<ReflogEntry>> {
    let opts = RunOpts {
        no_identity: true,
        ..RunOpts::default()
    }
    .env("GIT_OPTIONAL_LOCKS", "0");
    let args = [
        "reflog",
        "show",
        "--no-abbrev",
        "--date=iso-strict",
        "--format=%H%x1f%gD%x1f%gs%x1e",
        "-n",
        "150",
        "HEAD",
    ];
    match git.run(cwd, &args, opts).await {
        Ok(out) => Ok(parse_reflog(&out)),
        Err(error) => {
            // A repository with no commits has no HEAD reflog; other errors stay visible.
            if let Err(AppError::Git { message, .. }) = git
                .run(cwd, &["rev-parse", "--verify", "HEAD"], RunOpts::default())
                .await
            {
                let m = message.to_lowercase();
                if m.contains("needed a single revision") || m.contains("unknown revision") {
                    return Ok(Vec::new());
                }
            }
            Err(error)
        }
    }
}
