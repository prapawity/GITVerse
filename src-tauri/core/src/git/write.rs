//! Write-side Git operations from electron/git/git.ts (stage, commit, branch, merge, reset, …).
//! Error messages are kept identical: the UI and the golden write scenarios depend on them.
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::log::is_remote_head_alias;
use super::windows::{ensure_target_tree_supported, preflight};
use super::{status, FileStatus, GitRunner, OpKind, RunOpts};
use crate::error::{AppError, Result};

fn invalid(message: &str) -> AppError {
    AppError::Invalid(message.to_owned())
}

pub(crate) fn conflicted(f: &FileStatus) -> bool {
    matches!(
        format!("{}{}", f.index, f.worktree).as_str(),
        "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU"
    )
}

pub async fn stage(git: &GitRunner, cwd: &Path, paths: &[String]) -> Result<String> {
    if paths.is_empty() {
        return Err(invalid("No files selected."));
    }
    let files = status(git, cwd).await?;
    let stageable = |p: &String| {
        files
            .iter()
            .any(|f| &f.path == p && !conflicted(f) && (f.worktree != " " || f.index == "?"))
    };
    if !paths.iter().all(stageable) {
        return Err(invalid(
            "Some files changed or have conflicts. Refresh and review them first.",
        ));
    }
    let mut args = vec!["--literal-pathspecs", "add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git.run(cwd, &args, RunOpts::default()).await
}

pub async fn unstage(git: &GitRunner, cwd: &Path, paths: &[String]) -> Result<String> {
    if paths.is_empty() {
        return Err(invalid("No files selected."));
    }
    let files = status(git, cwd).await?;
    let mut names: Vec<String> = Vec::new();
    for p in paths {
        let f = files
            .iter()
            .find(|f| &f.path == p && f.index != " " && f.index != "?" && !conflicted(f))
            .ok_or_else(|| {
                invalid("Some files changed or have conflicts. Refresh and review them first.")
            })?;
        for name in std::iter::once(&f.path).chain(f.old_path.as_ref()) {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
    }
    let has_head = git.succeeds(cwd, &["rev-parse", "--verify", "HEAD"]).await;
    let mut args = vec!["--literal-pathspecs"];
    args.extend(if has_head {
        &["restore", "--staged"][..]
    } else {
        &["rm", "--cached", "-r", "--ignore-unmatch"][..]
    });
    args.push("--");
    args.extend(names.iter().map(String::as_str));
    git.run(cwd, &args, RunOpts::default()).await
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOpts {
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub signoff: bool,
    #[serde(default)]
    pub gpg_sign: bool,
    #[serde(default)]
    pub no_verify: bool,
}

pub async fn commit(
    git: &GitRunner,
    cwd: &Path,
    summary: &str,
    description: &str,
    opts: CommitOpts,
) -> Result<String> {
    let mut args: Vec<&str> =
        if opts.amend && summary.trim().is_empty() && description.trim().is_empty() {
            vec!["commit", "--no-edit"]
        } else {
            vec!["commit", "-m", summary]
        };
    if !description.trim().is_empty() {
        args.extend(["-m", description]);
    }
    if opts.amend {
        args.push("--amend");
    }
    if opts.signoff {
        args.push("--signoff");
    }
    if opts.gpg_sign {
        args.push("-S");
    }
    if opts.no_verify {
        args.push("--no-verify");
    }
    git.run(cwd, &args, RunOpts::default()).await
}

pub async fn checkout(git: &GitRunner, cwd: &Path, reference: &str) -> Result<String> {
    super::not_option("reference", reference)?;
    preflight(git, cwd, reference, "check out").await?;
    git.run(cwd, &["checkout", reference], RunOpts::default())
        .await
}

pub async fn create_branch(
    git: &GitRunner,
    cwd: &Path,
    name: &str,
    from: Option<&str>,
) -> Result<String> {
    super::not_option("branch name", name)?;
    if let Some(f) = from {
        super::not_option("start point", f)?;
    }
    git.run(
        cwd,
        &["checkout", "-b", name, from.unwrap_or("HEAD")],
        RunOpts::default(),
    )
    .await
}

pub async fn branch_at(git: &GitRunner, cwd: &Path, name: &str, hash: &str) -> Result<String> {
    super::not_option("branch name", name)?;
    super::not_option("commit", hash)?;
    ensure_target_tree_supported(git, cwd, hash, "create a branch from").await?;
    git.run(cwd, &["checkout", "-b", name, hash], RunOpts::default())
        .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

pub async fn reset(git: &GitRunner, cwd: &Path, hash: &str, mode: ResetMode) -> Result<String> {
    super::not_option("commit", hash)?;
    let name = match mode {
        ResetMode::Soft => "soft",
        ResetMode::Mixed => "mixed",
        ResetMode::Hard => "hard",
    };
    if mode != ResetMode::Soft {
        preflight(git, cwd, hash, &format!("{name} reset to")).await?;
    }
    git.run(
        cwd,
        &["reset", &format!("--{name}"), hash],
        RunOpts::default(),
    )
    .await
}

pub async fn cherry_pick(git: &GitRunner, cwd: &Path, hash: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    git.run(cwd, &["cherry-pick", hash], RunOpts::default())
        .await
}

pub async fn revert(git: &GitRunner, cwd: &Path, hash: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    git.run(cwd, &["revert", "--no-edit", hash], RunOpts::default())
        .await
}

pub async fn rebase_onto(git: &GitRunner, cwd: &Path, hash: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    git.run(cwd, &["rebase", hash], RunOpts::default()).await
}

/// GIT_EDITOR=true: accept the generated merge message instead of opening an editor we cannot show.
pub async fn merge(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
    no_ff: bool,
    ff_only: bool,
) -> Result<String> {
    super::not_option("reference", reference)?;
    let mut args = vec!["merge"];
    if ff_only {
        args.push("--ff-only");
    } else if no_ff {
        args.push("--no-ff");
    }
    args.extend(["--no-edit", reference]);
    git.run(cwd, &args, RunOpts::default().env("GIT_EDITOR", "true"))
        .await
}

pub async fn create_tag(git: &GitRunner, cwd: &Path, name: &str, hash: &str) -> Result<String> {
    super::not_option("tag name", name)?;
    super::not_option("commit", hash)?;
    git.run(cwd, &["tag", name, hash], RunOpts::default()).await
}

pub async fn create_annotated_tag(
    git: &GitRunner,
    cwd: &Path,
    name: &str,
    hash: &str,
    message: &str,
) -> Result<String> {
    super::not_option("tag name", name)?;
    super::not_option("commit", hash)?;
    let message = if message.is_empty() { name } else { message };
    git.run(
        cwd,
        &["tag", "-a", name, "-m", message, hash],
        RunOpts::default(),
    )
    .await
}

pub async fn tag_commit(git: &GitRunner, cwd: &Path, name: &str) -> Result<String> {
    if name.is_empty() || name.contains('\0') {
        return Err(invalid("Invalid tag."));
    }
    let spec = format!("refs/tags/{name}^{{commit}}");
    Ok(git
        .run(cwd, &["rev-parse", "--verify", &spec], RunOpts::default())
        .await?
        .trim()
        .to_owned())
}

pub async fn file_at(git: &GitRunner, cwd: &Path, hash: &str, path: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    git.run(
        cwd,
        &["show", &format!("{hash}:{path}")],
        RunOpts::default(),
    )
    .await
}

pub async fn format_patch(git: &GitRunner, cwd: &Path, hash: &str) -> Result<String> {
    super::not_option("commit", hash)?;
    git.run(
        cwd,
        &["format-patch", "-1", "--stdout", hash],
        RunOpts::default(),
    )
    .await
}

pub async fn remote_url(git: &GitRunner, cwd: &Path) -> Result<String> {
    Ok(git
        .run(cwd, &["remote", "get-url", "origin"], RunOpts::default())
        .await?
        .trim()
        .to_owned())
}

pub async fn fetch(git: &GitRunner, cwd: &Path, prune: bool) -> Result<String> {
    let mut args = vec!["fetch", "--all"];
    if prune {
        args.push("--prune");
    }
    git.run(cwd, &args, RunOpts::default()).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
pub enum PullMode {
    #[default]
    #[serde(rename = "ff")]
    Ff,
    #[serde(rename = "ff-only")]
    FfOnly,
    #[serde(rename = "rebase")]
    Rebase,
}

pub async fn pull(git: &GitRunner, cwd: &Path, mode: PullMode) -> Result<String> {
    let flag = match mode {
        PullMode::Rebase => "--rebase",
        PullMode::FfOnly => "--ff-only",
        PullMode::Ff => "--ff",
    };
    git.run(cwd, &["pull", flag], RunOpts::default()).await
}

pub async fn push(git: &GitRunner, cwd: &Path) -> Result<String> {
    git.run(cwd, &["push"], RunOpts::default()).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

pub async fn commit_identity(git: &GitRunner, cwd: &Path) -> Result<CommitIdentity> {
    let get = |key: &'static str| async move {
        git.run(cwd, &["config", "--get", key], RunOpts::default())
            .await
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let (name, email) = tokio::join!(get("user.name"), get("user.email"));
    Ok(CommitIdentity { name, email })
}

fn valid_email(email: &str) -> bool {
    let mut parts = email.splitn(2, '@');
    let (user, host) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let ok = |s: &str| !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c == '@');
    ok(user) && ok(host)
}

pub async fn set_commit_identity(
    git: &GitRunner,
    cwd: &Path,
    name: &str,
    email: &str,
) -> Result<()> {
    let both = format!("{name}{email}");
    if name.trim().is_empty()
        || email.trim().is_empty()
        || both.contains(['\r', '\n', '<', '>', '\0'])
        || !valid_email(email.trim())
    {
        return Err(invalid("Enter a valid name and email."));
    }
    let previous = git
        .run(
            cwd,
            &["config", "--local", "--get", "user.email"],
            RunOpts::default(),
        )
        .await
        .ok()
        .map(|s| s.trim().to_owned());
    git.run(
        cwd,
        &["config", "--local", "user.email", email.trim()],
        RunOpts::default(),
    )
    .await?;
    if let Err(error) = git
        .run(
            cwd,
            &["config", "--local", "user.name", name.trim()],
            RunOpts::default(),
        )
        .await
    {
        let restore: Vec<&str> = match &previous {
            None => vec!["config", "--local", "--unset-all", "user.email"],
            Some(prev) => vec!["config", "--local", "user.email", prev],
        };
        git.run(cwd, &restore, RunOpts::default()).await?;
        return Err(error);
    }
    Ok(())
}

// ---- in-progress operations ----

fn op_args(kind: OpKind, verb: &'static str) -> Vec<&'static str> {
    if kind == OpKind::Merge {
        return if verb == "abort" {
            vec!["merge", "--abort"]
        } else {
            vec!["commit", "--no-edit"]
        };
    }
    vec![
        kind.as_str(),
        match verb {
            "continue" => "--continue",
            "abort" => "--abort",
            _ => "--skip",
        },
    ]
}

/// With a message, a tiny "editor" writes it into the file git asks to edit, so the user's edit is
/// kept; without one, GIT_EDITOR=true accepts git's own message.
pub async fn op_continue(
    git: &GitRunner,
    cwd: &Path,
    kind: OpKind,
    message: Option<&str>,
) -> Result<String> {
    let args = if kind == OpKind::Merge && message.is_some() {
        vec!["commit"]
    } else {
        op_args(kind, "continue")
    };
    let opts = match message.filter(|m| !m.is_empty()) {
        Some(m) => RunOpts::default()
            .env(
                "GIT_EDITOR",
                r#"sh -c 'printf "%s\n" "$GITVERSE_MSG" > "$1"' sh"#,
            )
            .env("GITVERSE_MSG", m),
        None => RunOpts::default().env("GIT_EDITOR", "true"),
    };
    git.run(cwd, &args, opts).await
}

pub async fn op_abort(git: &GitRunner, cwd: &Path, kind: OpKind) -> Result<String> {
    git.run(
        cwd,
        &op_args(kind, "abort"),
        RunOpts::default().env("GIT_EDITOR", "true"),
    )
    .await
}

pub async fn op_skip(git: &GitRunner, cwd: &Path, kind: OpKind) -> Result<String> {
    git.run(
        cwd,
        &op_args(kind, "skip"),
        RunOpts::default().env("GIT_EDITOR", "true"),
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Ours,
    Theirs,
    Mark,
}

pub async fn resolve_file(git: &GitRunner, cwd: &Path, file: &str, side: Side) -> Result<()> {
    let flag = match side {
        Side::Ours => Some("--ours"),
        Side::Theirs => Some("--theirs"),
        Side::Mark => None,
    };
    if let Some(flag) = flag {
        if git
            .run(cwd, &["checkout", flag, "--", file], RunOpts::default())
            .await
            .is_err()
        {
            // that side deleted the file: taking its version means removing it
            git.run(cwd, &["rm", "--quiet", "--", file], RunOpts::default())
                .await?;
            return Ok(());
        }
    }
    git.run(cwd, &["add", "--", file], RunOpts::default())
        .await?;
    Ok(())
}

// ---- branch deletion ----

/// Delete only when Git confirms the branch is merged locally or into a fetched remote tip.
pub async fn delete_branch(git: &GitRunner, cwd: &Path, name: &str, force: bool) -> Result<String> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(invalid("Invalid local branch name."));
    }
    git.run(
        cwd,
        &["check-ref-format", "--branch", name],
        RunOpts::default(),
    )
    .await?;
    let current = git
        .run(cwd, &["branch", "--show-current"], RunOpts::default())
        .await?;
    if current.trim() == name {
        return Err(AppError::Invalid(format!(
            "Cannot delete {name} while it is checked out."
        )));
    }
    // Force deletion is only reachable through the explicit, separately confirmed UI action.
    if force {
        return git
            .run(cwd, &["branch", "-D", "--", name], RunOpts::default())
            .await;
    }
    match git
        .run(cwd, &["branch", "-d", "--", name], RunOpts::default())
        .await
    {
        Ok(out) => return Ok(out),
        Err(error) => {
            let detail = error.to_string().to_lowercase();
            if !(detail.contains("not fully merged") || detail.contains("not merged")) {
                return Err(error);
            }
        }
    }
    let remotes = git
        .run(
            cwd,
            &["for-each-ref", "--format=%(refname)", "refs/remotes/"],
            RunOpts::default(),
        )
        .await?;
    let local = format!("refs/heads/{name}");
    for remote_ref in remotes.split('\n').filter(|l| !l.is_empty()) {
        match git
            .run(
                cwd,
                &["merge-base", "--is-ancestor", &local, remote_ref],
                RunOpts::default(),
            )
            .await
        {
            // `-d` only checks HEAD and the upstream; ancestry of this fetched tip is proven
            Ok(_) => {
                return git
                    .run(cwd, &["branch", "-D", "--", name], RunOpts::default())
                    .await
            }
            // exit 1 means "not an ancestor"; anything else is a real failure
            Err(AppError::Git { code: Some(1), .. }) => {}
            Err(error) => return Err(error),
        }
    }
    Err(AppError::Invalid(format!(
        "Cannot delete {name}: it is not merged into the current branch or any fetched remote branch. Fetch first, or merge it before deleting."
    )))
}

pub async fn delete_remote_branch(git: &GitRunner, cwd: &Path, name: &str) -> Result<()> {
    let slash = name.find('/').unwrap_or(0);
    let (remote, branch) = (&name[..slash], name.get(slash + 1..).unwrap_or_default());
    if slash < 1
        || branch.is_empty()
        || name.contains('\0')
        || remote.starts_with('-')
        || branch.starts_with('-')
    {
        return Err(invalid("Invalid remote branch."));
    }
    if is_remote_head_alias(name) {
        return Err(AppError::Invalid(format!(
            "{name} points to the remote's default branch and cannot be deleted."
        )));
    }
    let remotes = git.run(cwd, &["remote"], RunOpts::default()).await?;
    if !remotes.split('\n').any(|r| r == remote) {
        return Err(invalid("The selected remote no longer exists."));
    }
    git.run(
        cwd,
        &["check-ref-format", "--branch", branch],
        RunOpts::default(),
    )
    .await?;
    git.run(
        cwd,
        &["push", "--delete", "--", remote, branch],
        RunOpts::default(),
    )
    .await?;
    Ok(())
}

// ---- working-tree files for the merge tool (confined to the repository) ----

/// `path.resolve` semantics: join, then fold `.` and `..` lexically.
fn resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for part in base.join(rel).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub(crate) fn within(root: &Path, target: &Path) -> bool {
    target != root && target.starts_with(root)
}

pub(crate) fn canonical(p: &Path) -> Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    // Windows canonical paths carry a \\?\ prefix; strip it so prefixes compare like Node's realpath
    #[cfg(windows)]
    let c = c
        .to_str()
        .and_then(|s| s.strip_prefix(r"\\?\"))
        .map(PathBuf::from)
        .unwrap_or(c);
    Ok(c)
}

pub(crate) fn work_path(cwd: &Path, rel: &str) -> Result<(PathBuf, PathBuf)> {
    let outside = || invalid("Path is outside the repository");
    let root = canonical(cwd)?;
    let full = resolve(&root, rel);
    if !within(&root, &full) {
        return Err(outside());
    }
    let parent = canonical(full.parent().ok_or_else(outside)?)?;
    if parent != root && !within(&root, &parent) {
        return Err(outside());
    }
    let name = full.file_name().ok_or_else(outside)?;
    Ok((root, parent.join(name)))
}

pub fn read_work_file(cwd: &Path, rel: &str) -> Result<String> {
    let (root, full) = work_path(cwd, rel)?;
    let target = canonical(&full)?;
    if !within(&root, &target) {
        return Err(invalid("Path is outside the repository"));
    }
    Ok(std::fs::read_to_string(target)?)
}

pub fn write_work_file(cwd: &Path, rel: &str, text: &str) -> Result<()> {
    let (_, full) = work_path(cwd, rel)?;
    // never write through a symlink (O_NOFOLLOW in the TS version)
    if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(invalid("Path is outside the repository"));
    }
    std::fs::write(full, text)?;
    Ok(())
}

/// Stage and commit only `paths` (deletions and both sides of renames included); other staged
/// changes stay staged and are not part of this commit (`commitFiles` in git.ts).
pub async fn commit_files(
    git: &GitRunner,
    cwd: &Path,
    paths: &[String],
    summary: &str,
    description: &str,
) -> Result<String> {
    if paths.is_empty() {
        return Err(invalid("Choose at least one file for this commit."));
    }
    if summary.trim().is_empty() {
        return Err(invalid("Each commit needs a summary."));
    }
    let files = status(git, cwd).await?;
    if files.iter().any(conflicted) {
        return Err(invalid("Resolve conflicts before composing commits."));
    }
    let mut names: Vec<String> = Vec::new();
    // only changes not yet in the index need adding; staged deletions / renames are already there
    let mut unstaged: Vec<String> = Vec::new();
    for p in paths {
        let f = files.iter().find(|f| &f.path == p).ok_or_else(|| {
            AppError::Invalid(format!(
                "{p} has no uncommitted changes any more. Refresh and try again."
            ))
        })?;
        if f.worktree != " " && !unstaged.contains(&f.path) {
            unstaged.push(f.path.clone());
        }
        for n in std::iter::once(&f.path).chain(f.old_path.iter()) {
            if !names.contains(n) {
                names.push(n.clone());
            }
        }
    }
    if !unstaged.is_empty() {
        let mut add: Vec<&str> = vec!["--literal-pathspecs", "add", "-A", "--"];
        add.extend(unstaged.iter().map(String::as_str));
        git.run(cwd, &add, RunOpts::default()).await?;
    }
    let mut args: Vec<&str> = vec![
        "--literal-pathspecs",
        "commit",
        "--only",
        "-m",
        summary.trim(),
    ];
    if !description.trim().is_empty() {
        args.extend(["-m", description.trim()]);
    }
    args.push("--");
    args.extend(names.iter().map(String::as_str));
    git.run(cwd, &args, RunOpts::default()).await
}
