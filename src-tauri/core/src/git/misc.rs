//! Remaining operations from electron/git/git.ts and workspaceInspection.ts: commit-message input,
//! squash, multi cherry-pick, rebase preview, blobs, worktrees, checkpoints, stash files.
use std::path::Path;

use base64::Engine as _;
use serde::Serialize;

use super::log::is_object_id;
use super::windows::ensure_target_tree_supported;
use super::{op_state, stash_detail, status, GitRunner, RunOpts};
use crate::error::{AppError, Result};

fn invalid(m: impl Into<String>) -> AppError {
    AppError::Invalid(m.into())
}

fn is_full_hash(h: &str) -> bool {
    (40..=64).contains(&h.len()) && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StagedDiff {
    pub tree: String,
    pub diff: String,
}

/// The staged diff for an AI commit message, tied to the index tree it was read from.
pub async fn staged_for_commit_message(git: &GitRunner, cwd: &Path) -> Result<StagedDiff> {
    let tree = git
        .run(cwd, &["write-tree"], RunOpts::default())
        .await?
        .trim()
        .to_owned();
    let args = [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--",
    ];
    let diff = git.run(cwd, &args, RunOpts::default()).await?;
    if diff.trim().is_empty() {
        return Err(invalid("Stage changes before generating a commit message."));
    }
    if diff.encode_utf16().count() > 150_000 {
        return Err(invalid(
            "The staged diff is too large to send to AI. Stage fewer changes and try again.",
        ));
    }
    if git
        .run(cwd, &["write-tree"], RunOpts::default())
        .await?
        .trim()
        != tree
    {
        return Err(invalid(
            "Staged changes changed while preparing the diff. Try again.",
        ));
    }
    Ok(StagedDiff { tree, diff })
}

async fn parents(git: &GitRunner, cwd: &Path, hash: &str) -> Result<Vec<String>> {
    let out = git
        .run(
            cwd,
            &["rev-list", "--parents", "-n", "1", hash],
            RunOpts::default(),
        )
        .await?;
    Ok(out.trim().split(' ').map(str::to_owned).collect())
}

fn distinct(hashes: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    hashes.iter().all(|h| seen.insert(h))
}

/// Replace the newest `hashes` (HEAD first, consecutive, linear) with one commit.
pub async fn squash_commits(
    git: &GitRunner,
    cwd: &Path,
    hashes: &[String],
    message: &str,
) -> Result<()> {
    if hashes.len() < 2
        || hashes.len() > 500
        || !hashes.iter().all(|h| is_full_hash(h))
        || !distinct(hashes)
    {
        return Err(invalid("Select at least two distinct commits."));
    }
    if message.trim().is_empty()
        || message.encode_utf16().count() > 10_000
        || message.contains('\0')
    {
        return Err(invalid("Enter a valid commit message."));
    }
    if op_state(git, cwd).await?.is_some() {
        return Err(invalid(
            "Finish the current Git operation before squashing.",
        ));
    }
    if !status(git, cwd).await?.is_empty() {
        return Err(invalid(
            "Commit or stash all working changes before squashing.",
        ));
    }
    let branch = git
        .run(cwd, &["symbolic-ref", "-q", "HEAD"], RunOpts::default())
        .await
        .unwrap_or_default();
    let branch = branch.trim().to_owned();
    if !branch.starts_with("refs/heads/") {
        return Err(invalid("Check out a local branch before squashing."));
    }
    let head = git
        .run(cwd, &["rev-parse", "HEAD"], RunOpts::default())
        .await?
        .trim()
        .to_owned();
    if hashes[0] != head {
        return Err(invalid(
            "Select consecutive commits starting at the current branch HEAD.",
        ));
    }
    let mut parent = String::new();
    for (i, hash) in hashes.iter().enumerate() {
        let fields = parents(git, cwd, hash).await?;
        if fields.len() != 2 {
            return Err(invalid(
                "Squash supports only linear commits with one parent; merge and root commits cannot be included.",
            ));
        }
        parent = fields[1].clone();
        if i + 1 < hashes.len() && hashes[i + 1] != parent {
            return Err(invalid(
                "Selected commits must be consecutive on the current branch.",
            ));
        }
    }
    let tree = git
        .run(
            cwd,
            &["rev-parse", &format!("{head}^{{tree}}")],
            RunOpts::default(),
        )
        .await?;
    let opts = RunOpts {
        stdin: Some(format!("{}\n", message.trim())),
        ..RunOpts::default()
    };
    let commit = git
        .run(
            cwd,
            &["commit-tree", tree.trim(), "-p", &parent, "-F", "-"],
            opts,
        )
        .await?;
    let still = git
        .run(cwd, &["symbolic-ref", "-q", "HEAD"], RunOpts::default())
        .await
        .unwrap_or_default();
    if still.trim() != branch
        || !status(git, cwd).await?.is_empty()
        || op_state(git, cwd).await?.is_some()
    {
        return Err(invalid(
            "The repository changed; review it before trying again.",
        ));
    }
    let reason = format!("squash {} commits", hashes.len());
    git.run(
        cwd,
        &["update-ref", "-m", &reason, &branch, commit.trim(), &head],
        RunOpts::default(),
    )
    .await?;
    Ok(())
}

pub async fn cherry_pick_many(git: &GitRunner, cwd: &Path, hashes: &[String]) -> Result<String> {
    if hashes.len() < 2
        || hashes.len() > 500
        || !distinct(hashes)
        || !hashes.iter().all(|h| is_full_hash(h))
    {
        return Err(invalid("Select at least two valid commits."));
    }
    for hash in hashes {
        if parents(git, cwd, hash).await?.len() > 2 {
            return Err(invalid(
                "Multi-commit cherry-pick does not support merge commits.",
            ));
        }
    }
    let args: Vec<&str> = std::iter::once("cherry-pick")
        .chain(hashes.iter().map(String::as_str))
        .collect();
    git.run(cwd, &args, RunOpts::default()).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedCommit {
    pub hash: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RebasePlan {
    pub branch: String,
    pub head: String,
    pub base: String,
    pub upstream: String,
    pub commits: Vec<PlannedCommit>,
}

/// The unpublished linear commits after `base`, for the interactive rebase planner (read-only).
pub async fn rebase_preview(git: &GitRunner, cwd: &Path, base: &str) -> Result<RebasePlan> {
    if !((base.len() == 40 || base.len() == 64) && is_object_id(base)) {
        return Err(invalid("Select a valid commit as the base."));
    }
    if op_state(git, cwd).await?.is_some() {
        return Err(invalid("Finish the current Git operation first."));
    }
    let branch = git
        .run(
            cwd,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            RunOpts::default(),
        )
        .await
        .unwrap_or_default();
    let branch = branch.trim().to_owned();
    if branch.is_empty() {
        return Err(invalid(
            "Check out a local branch before planning a rebase.",
        ));
    }
    let head = git
        .run(cwd, &["rev-parse", "--verify", "HEAD"], RunOpts::default())
        .await?
        .trim()
        .to_owned();
    let upstream = git
        .run(
            cwd,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
            RunOpts::default(),
        )
        .await
        .unwrap_or_default()
        .trim()
        .to_owned();
    if upstream.is_empty() {
        return Err(invalid(
            "Set an upstream branch before planning unpublished commits.",
        ));
    }
    if !git
        .succeeds(cwd, &["merge-base", "--is-ancestor", base, &head])
        .await
    {
        return Err(invalid(
            "The selected base must be an ancestor of the current branch.",
        ));
    }
    let range = format!("{base}..{head}");
    let out = git
        .run(
            cwd,
            &["rev-list", "--reverse", "--parents", &range],
            RunOpts::default(),
        )
        .await?;
    let lines: Vec<&str> = out.split('\n').filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Err(invalid("There are no commits after the selected base."));
    }
    if lines.len() > 100 {
        return Err(invalid("Choose a range of at most 100 commits."));
    }
    let mut parent = base.to_owned();
    let mut commits = Vec::new();
    for line in lines {
        let mut fields = line.split(' ');
        let hash = fields.next().unwrap_or_default().to_owned();
        let ps: Vec<&str> = fields.collect();
        if ps.len() != 1 || ps[0] != parent {
            return Err(invalid("Choose a linear range without merge commits."));
        }
        if git
            .succeeds(cwd, &["merge-base", "--is-ancestor", &hash, &upstream])
            .await
        {
            return Err(invalid(
                "The selected range contains commits already reachable from the upstream branch.",
            ));
        }
        let subject = git
            .run(
                cwd,
                &["show", "-s", "--format=%s", &hash],
                RunOpts::default(),
            )
            .await?
            .trim()
            .to_owned();
        parent = hash.clone();
        commits.push(PlannedCommit { hash, subject });
    }
    if git
        .run(cwd, &["rev-parse", "--verify", "HEAD"], RunOpts::default())
        .await?
        .trim()
        != head
    {
        return Err(invalid(
            "The branch changed while preparing the preview. Try again.",
        ));
    }
    Ok(RebasePlan {
        branch,
        head,
        base: base.to_owned(),
        upstream,
        commits,
    })
}

const MAX_BLOB_BYTES: usize = 50 * 1024 * 1024;

/// A file's bytes at a commit, base64-encoded (images, media, binary previews).
pub async fn file_blob_at(git: &GitRunner, cwd: &Path, hash: &str, path: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    let bytes = git
        .run_bytes(
            cwd,
            &["show", &format!("{hash}:{path}")],
            RunOpts::default(),
        )
        .await?;
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(invalid("File is too large to preview (over 50 MB)."));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn working_file_blob(cwd: &Path, path: &str) -> Result<String> {
    // work_path canonicalises the parent, so a symlinked directory cannot reach outside the repo.
    let (_, normalized) = super::write::work_path(cwd, path).map_err(|e| match e {
        AppError::Invalid(_) => invalid("File is outside the repository."),
        other => other,
    })?;
    let meta = std::fs::symlink_metadata(&normalized)?;
    if !meta.is_file() {
        return Err(invalid("Only regular files can be previewed."));
    }
    if meta.len() as usize > MAX_BLOB_BYTES {
        return Err(invalid("File is too large to preview (over 50 MB)."));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(normalized)?))
}

pub async fn worktree_add(git: &GitRunner, cwd: &Path, path: &str, hash: &str) -> Result<String> {
    super::not_option("worktree path", path)?;
    super::not_option("commit", hash)?;
    ensure_target_tree_supported(git, cwd, hash, "create a worktree from").await?;
    git.run(
        cwd,
        &["worktree", "add", "--detach", path, hash],
        RunOpts::default(),
    )
    .await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Checkpoint {
    #[serde(rename = "ref")]
    pub reference: String,
    pub hash: String,
    pub subject: String,
}

pub async fn agent_checkpoints(git: &GitRunner, cwd: &Path) -> Result<Vec<Checkpoint>> {
    let out = git
        .run(
            cwd,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%09%(objectname:short)%09%(subject)",
                "refs/agents/",
            ],
            RunOpts::default(),
        )
        .await?;
    Ok(out
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut f = l.splitn(3, '\t');
            let mut next = || f.next().unwrap_or_default().to_owned();
            Checkpoint {
                reference: next(),
                hash: next(),
                subject: next(),
            }
        })
        .collect())
}

pub async fn stash_file_diff(git: &GitRunner, cwd: &Path, id: &str, path: &str) -> Result<String> {
    let detail = stash_detail(git, cwd, id).await?;
    let file = detail
        .files
        .iter()
        .find(|f| f.path == path)
        .ok_or_else(|| invalid("This file is not in the selected stash."))?;
    if file.untracked == Some(true) {
        let third = format!("{}^3", detail.hash);
        let args = [
            "--literal-pathspecs",
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--patch",
            "-r",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            &third,
            "--",
            &file.path,
        ];
        return git.run(cwd, &args, RunOpts::default()).await;
    }
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        &detail.base_hash,
        &detail.hash,
        "--",
    ];
    args.extend(file.old_path.as_deref());
    args.push(&file.path);
    git.run(cwd, &args, RunOpts::default()).await
}

pub async fn stash_file_at(git: &GitRunner, cwd: &Path, id: &str, path: &str) -> Result<String> {
    let detail = stash_detail(git, cwd, id).await?;
    let file = detail
        .files
        .iter()
        .find(|f| f.path == path)
        .filter(|f| f.status != "D")
        .ok_or_else(|| invalid("This file is not available in the selected stash."))?;
    let suffix = if file.untracked == Some(true) {
        "^3"
    } else {
        ""
    };
    git.run(
        cwd,
        &["show", &format!("{}{suffix}:{}", detail.hash, file.path)],
        RunOpts::default(),
    )
    .await
}
