//! `opState`: an in-progress rebase / merge / cherry-pick / revert and its conflicts.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{GitRunner, RunOpts};
use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpKind {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedFile {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpState {
    pub kind: OpKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// Still conflicted.
    pub files: Vec<String>,
    /// Staged so far.
    pub resolved: Vec<ResolvedFile>,
    /// Branch being rebased / receiving the change.
    pub head: String,
    /// What it is rebased onto / merged from (short hash).
    pub onto: String,
    /// The message git will commit with on continue.
    pub message: String,
}

fn read_trimmed(path: PathBuf) -> String {
    std::fs::read_to_string(path)
        .map(|t| t.trim().to_owned())
        .unwrap_or_default()
}

impl OpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OpKind::Rebase => "rebase",
            OpKind::Merge => "merge",
            OpKind::CherryPick => "cherry-pick",
            OpKind::Revert => "revert",
        }
    }
}

pub async fn op_state(git: &GitRunner, cwd: &Path) -> Result<Option<OpState>> {
    let dir = cwd.join(
        git.run(cwd, &["rev-parse", "--git-dir"], RunOpts::default())
            .await?
            .trim(),
    );
    let rebase_merge = dir.join("rebase-merge");
    let (kind, step) = if rebase_merge.exists() || dir.join("rebase-apply").exists() {
        let step = match (
            std::fs::read_to_string(rebase_merge.join("msgnum")),
            std::fs::read_to_string(rebase_merge.join("end")),
        ) {
            (Ok(cur), Ok(end)) => Some(format!("{}/{}", cur.trim(), end.trim())),
            _ => None, // apply-style rebase has no step files
        };
        (OpKind::Rebase, step)
    } else if dir.join("MERGE_HEAD").exists() {
        (OpKind::Merge, None)
    } else if dir.join("CHERRY_PICK_HEAD").exists() {
        (OpKind::CherryPick, None)
    } else if dir.join("REVERT_HEAD").exists() {
        (OpKind::Revert, None)
    } else {
        return Ok(None);
    };

    let files: Vec<String> = git
        .run(
            cwd,
            &["diff", "--name-only", "--diff-filter=U"],
            RunOpts::default(),
        )
        .await?
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    let resolved = git
        .run(
            cwd,
            &["diff", "--cached", "--name-status", "--diff-filter=ACDMR"],
            RunOpts::default(),
        )
        .await?
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let parts: Vec<&str> = l.split('\t').collect();
            ResolvedFile {
                status: parts[0].chars().next().unwrap_or(' ').to_string(),
                path: parts.last().copied().unwrap_or_default().to_owned(),
            }
        })
        .filter(|f| !files.contains(&f.path))
        .collect();

    let short = |reference: String| async move {
        if reference.is_empty() {
            return String::new();
        }
        git.run(
            cwd,
            &["rev-parse", "--short", &reference],
            RunOpts::default(),
        )
        .await
        .map(|s| s.trim().to_owned())
        .unwrap_or(reference)
    };
    let (head, onto) = if kind == OpKind::Rebase {
        let base = if rebase_merge.exists() {
            "rebase-merge"
        } else {
            "rebase-apply"
        };
        let head_name = read_trimmed(dir.join(base).join("head-name"));
        let head = head_name.strip_prefix("refs/heads/").unwrap_or(&head_name);
        let head = if head.is_empty() {
            "HEAD".to_owned()
        } else {
            head.to_owned()
        };
        (head, short(read_trimmed(dir.join(base).join("onto"))).await)
    } else {
        let branch = git
            .run(cwd, &["branch", "--show-current"], RunOpts::default())
            .await
            .unwrap_or_default();
        let branch = branch.trim();
        let marker = match kind {
            OpKind::Merge => "MERGE_HEAD",
            OpKind::CherryPick => "CHERRY_PICK_HEAD",
            _ => "REVERT_HEAD",
        };
        (
            if branch.is_empty() {
                "HEAD".to_owned()
            } else {
                branch.to_owned()
            },
            short(read_trimmed(dir.join(marker))).await,
        )
    };
    // MERGE_MSG holds the message git will commit with; drop git's "# Conflicts:" comment block
    let message = read_trimmed(dir.join("MERGE_MSG"))
        .split('\n')
        .filter(|l| !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned();
    Ok(Some(OpState {
        kind,
        step,
        files,
        resolved,
        head,
        onto,
        message,
    }))
}
