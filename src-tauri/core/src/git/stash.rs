//! Stash operations from electron/git/git.ts.
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::log::is_object_id;
use super::refs::stash_entries;
use super::show::commit_detail;
use super::{op_state, GitRunner, RunOpts};
use crate::error::{AppError, Result};

pub async fn stash(git: &GitRunner, cwd: &Path, message: Option<&str>) -> Result<String> {
    let mut args = vec!["stash", "push", "--include-untracked"];
    if let Some(m) = message {
        args.extend(["-m", m]);
    }
    git.run(cwd, &args, RunOpts::default()).await
}

pub async fn stash_pop(git: &GitRunner, cwd: &Path) -> Result<String> {
    git.run(cwd, &["stash", "pop"], RunOpts::default()).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StashOp {
    Apply,
    Pop,
    Drop,
}

/// Apply/pop/drop the stash with this commit hash (resolved to its current `stash@{n}`).
pub async fn stash_action(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    action: StashOp,
) -> Result<String> {
    if !(hash.len() == 40 || hash.len() == 64) || !is_object_id(hash) {
        return Err(AppError::Invalid(
            "Invalid stash identity. Refresh the repository.".into(),
        ));
    }
    if op_state(git, cwd).await?.is_some() {
        return Err(AppError::Invalid(
            "Finish the current Git operation first.".into(),
        ));
    }
    let matches: Vec<_> = stash_entries(git, cwd)
        .await?
        .into_iter()
        .filter(|e| e.hash == hash)
        .collect();
    let [entry] = matches.as_slice() else {
        return Err(AppError::Invalid(
            "This stash changed or is ambiguous. Refresh the repository.".into(),
        ));
    };
    // A hash identifies the content for apply; pop and drop need the current reflog selector.
    let (verb, target) = match action {
        StashOp::Apply => ("apply", hash),
        StashOp::Pop => ("pop", entry.id.as_str()),
        StashOp::Drop => ("drop", entry.id.as_str()),
    };
    git.run(cwd, &["stash", verb, target], RunOpts::default())
        .await
}

fn is_stash_selector(id: &str) -> bool {
    id.strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_stash_id(id: &str) -> bool {
    is_stash_selector(id) || ((id.len() == 40 || id.len() == 64) && is_object_id(id))
}

pub async fn stash_rename(git: &GitRunner, cwd: &Path, id: &str, message: &str) -> Result<()> {
    if !valid_stash_id(id) {
        return Err(AppError::Invalid("Invalid stash.".into()));
    }
    if message.trim().is_empty() || message.encode_utf16().count() > 200 {
        return Err(AppError::Invalid(
            "Enter a stash name of 1–200 characters.".into(),
        ));
    }
    let entries = stash_entries(git, cwd).await?;
    let Some(index) = entries.iter().position(|e| e.id == id || e.hash == id) else {
        return Err(AppError::Invalid(
            "This stash is no longer available. Refresh the repository.".into(),
        ));
    };
    let hash = entries[index].hash.clone();
    let msg = message.trim();
    if index == 0 {
        // `stash store` of the commit that is already the newest stash adds no reflog entry, so
        // store-then-drop would delete this stash (or the one under it). Replace it in place.
        let original = git
            .run(
                cwd,
                &["log", "-1", "--walk-reflogs", "--format=%gs", "stash@{0}"],
                RunOpts::default(),
            )
            .await?;
        git.run(cwd, &["stash", "drop", "stash@{0}"], RunOpts::default())
            .await?;
        if let Err(error) = git
            .run(
                cwd,
                &["stash", "store", "--message", msg, &hash],
                RunOpts::default(),
            )
            .await
        {
            git.run(
                cwd,
                &["stash", "store", "--message", original.trim(), &hash],
                RunOpts::default(),
            )
            .await?;
            return Err(error);
        }
        return Ok(());
    }
    git.run(
        cwd,
        &["stash", "store", "--message", msg, &hash],
        RunOpts::default(),
    )
    .await?;
    let older = format!("stash@{{{}}}", index + 1);
    if let Err(error) = git
        .run(cwd, &["stash", "drop", &older], RunOpts::default())
        .await
    {
        let _ = git
            .run(cwd, &["stash", "drop", "stash@{0}"], RunOpts::default())
            .await;
        return Err(error);
    }
    Ok(())
}

pub async fn stash_diff(git: &GitRunner, cwd: &Path, id: &str) -> Result<String> {
    if !is_stash_selector(id) {
        return Err(AppError::Invalid("Invalid stash.".into()));
    }
    git.run(
        cwd,
        &[
            "stash",
            "show",
            "--include-untracked",
            "--patch",
            "--no-ext-diff",
            "--no-color",
            id,
        ],
        RunOpts::default(),
    )
    .await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetail {
    pub id: String,
    pub hash: String,
    pub base_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub body: String,
    pub message: String,
    pub files: Vec<StashFile>,
}

pub async fn stash_detail(git: &GitRunner, cwd: &Path, id: &str) -> Result<StashDetail> {
    if !valid_stash_id(id) {
        return Err(AppError::Invalid("Invalid stash.".into()));
    }
    let gone =
        || AppError::Invalid("This stash is no longer available. Refresh the repository.".into());
    let stash = stash_entries(git, cwd)
        .await?
        .into_iter()
        .find(|e| e.id == id || e.hash == id)
        .ok_or_else(gone)?;
    if stash.hash.is_empty() || stash.base_hash.is_empty() {
        return Err(gone());
    }
    let tracked = commit_detail(git, cwd, &stash.hash).await?;
    let mut files: Vec<StashFile> = tracked
        .files
        .into_iter()
        .map(|f| StashFile {
            status: f.status,
            path: f.path,
            old_path: f.old_path,
            untracked: None,
        })
        .collect();
    let third = format!("{}^3", stash.hash);
    let untracked = git
        .run(cwd, &["rev-parse", "--verify", &third], RunOpts::default())
        .await
        .unwrap_or_default();
    if !untracked.trim().is_empty() {
        let paths = git
            .run(
                cwd,
                &["ls-tree", "-r", "--name-only", "-z", untracked.trim()],
                RunOpts::default(),
            )
            .await?;
        files.extend(
            paths
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(|p| StashFile {
                    status: "A".into(),
                    path: p.to_owned(),
                    old_path: None,
                    untracked: Some(true),
                }),
        );
    }
    Ok(StashDetail {
        id: stash.id,
        hash: stash.hash,
        base_hash: stash.base_hash,
        author: stash.author,
        email: stash.email,
        date: stash.date,
        body: tracked.body,
        message: stash.message,
        files,
    })
}
