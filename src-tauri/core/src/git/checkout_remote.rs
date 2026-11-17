//! `checkoutRemote`: check out a remote branch, reusing or fast-forwarding a local branch that
//! tracks it, with the Windows sparse-checkout safeguards from electron/git/git.ts.
use std::path::Path;

use super::windows::{
    ensure_target_tree_supported, path_blocker, sparse_exclude_pattern, sparse_patterns,
    sparse_unexcluded, unsupported_tree_paths,
};
use super::write::canonical;
use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

fn invalid(m: impl Into<String>) -> AppError {
    AppError::Invalid(m.into())
}

async fn changes(git: &GitRunner, cwd: &Path) -> Result<String> {
    git.run(
        cwd,
        &["status", "--porcelain", "--untracked-files=all"],
        RunOpts::default(),
    )
    .await
}

async fn enable_windows_sparse(git: &GitRunner, cwd: &Path, paths: &[String]) -> Result<()> {
    if !cfg!(windows) || paths.is_empty() {
        return Ok(());
    }
    let mut next = sparse_patterns(git, cwd)
        .await?
        .unwrap_or_else(|| vec!["/*".to_owned()]);
    for path in paths {
        let pattern = sparse_exclude_pattern(path)?;
        if !next.contains(&pattern) {
            next.push(pattern);
        }
    }
    let opts = RunOpts {
        stdin: Some(format!("{}\n", next.join("\n"))),
        ..RunOpts::default()
    };
    git.run(
        cwd,
        &["sparse-checkout", "set", "--no-cone", "--stdin"],
        opts,
    )
    .await?;
    Ok(())
}

async fn prepare_windows_sparse(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
    allow: bool,
    expected: Option<&[String]>,
) -> Result<Vec<String>> {
    let unsupported = unsupported_tree_paths(git, cwd, reference).await?;
    let unexcluded = sparse_unexcluded(git, cwd, unsupported).await?;
    if let Some(expected) = expected {
        let (mut a, mut b) = (expected.to_vec(), unexcluded.clone());
        a.sort();
        b.sort();
        if a != b {
            return Err(invalid(
                "The remote branch changed while confirmation was open. Refresh and retry so you can review the files sparse checkout would omit.",
            ));
        }
    }
    if !unexcluded.is_empty() && !allow {
        return Err(invalid(path_blocker("check out", reference, &unexcluded)));
    }
    if !unexcluded.is_empty() {
        if !changes(git, cwd).await?.trim().is_empty() {
            return Err(invalid(
                "Cannot enable sparse checkout while the index or working tree has local changes. Commit or stash them first. No repository state was changed.",
            ));
        }
        enable_windows_sparse(git, cwd, &unexcluded).await?;
    }
    Ok(unexcluded)
}

async fn ensure_fast_forward_safe(
    git: &GitRunner,
    cwd: &Path,
    branch: &str,
    reference: &str,
) -> Result<()> {
    let all = unsupported_tree_paths(git, cwd, reference).await?;
    let local = changes(git, cwd).await?;
    let unsupported = sparse_unexcluded(git, cwd, all).await?;
    let mut reasons = Vec::new();
    if !unsupported.is_empty() {
        let examples = unsupported
            .iter()
            .take(6)
            .map(|p| format!("'{p}'"))
            .collect::<Vec<_>>()
            .join("\n");
        let more = if unsupported.len() > 6 {
            format!("\n…and {} more.", unsupported.len() - 6)
        } else {
            String::new()
        };
        reasons.push(format!(
            "Windows cannot create file names in {reference}:\n{examples}{more}\nAsk the repository owner to rename these paths."
        ));
    }
    if !local.trim().is_empty() {
        reasons.push(format!(
            "The index or working tree has local changes. Commit or stash them before fast-forwarding {branch}."
        ));
    }
    if reasons.is_empty() {
        return Ok(());
    }
    Err(invalid(format!(
        "Cannot align {branch} with {reference} yet:\n\n{}\n\nYour local branch and work have been preserved.",
        reasons.join("\n\n")
    )))
}

async fn ensure_not_checked_out_elsewhere(git: &GitRunner, cwd: &Path, branch: &str) -> Result<()> {
    let active = canonical(cwd)?.to_string_lossy().to_lowercase();
    let list = git
        .run(
            cwd,
            &["worktree", "list", "--porcelain"],
            RunOpts::default(),
        )
        .await?;
    for row in list.split("\n\n") {
        let worktree = row.lines().find_map(|l| l.strip_prefix("worktree "));
        let checked_out = row
            .lines()
            .find_map(|l| l.strip_prefix("branch refs/heads/"));
        if let (Some(worktree), Some(b)) = (worktree, checked_out) {
            let other = canonical(Path::new(worktree))
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| worktree.to_lowercase());
            if b == branch && other != active {
                return Err(invalid(format!(
                    "Cannot check out {branch}: it is already checked out in another worktree ({worktree})."
                )));
            }
        }
    }
    Ok(())
}

async fn is_ancestor(git: &GitRunner, cwd: &Path, a: &str, b: &str) -> bool {
    git.succeeds(cwd, &["merge-base", "--is-ancestor", a, b])
        .await
}

/// Returns the local branch name that is now checked out.
pub async fn checkout_remote(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
    allow_windows_sparse: bool,
    expected_unsupported: Option<&[String]>,
) -> Result<String> {
    let slash = reference.find('/').unwrap_or(0);
    if slash < 1 || slash == reference.len() - 1 {
        return Err(invalid("Invalid remote branch."));
    }
    let remote_ref = format!("refs/remotes/{reference}");
    git.run(
        cwd,
        &["show-ref", "--verify", "--quiet", &remote_ref],
        RunOpts::default(),
    )
    .await?;
    let name = &reference[slash + 1..];
    let list = git
        .run(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname:lstrip=2)%09%(upstream)",
                "refs/heads/",
            ],
            RunOpts::default(),
        )
        .await?;
    let branches: Vec<(String, String)> = list
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (b, u) = l.split_once('\t').unwrap_or((l, ""));
            (b.to_owned(), u.to_owned())
        })
        .collect();
    let tracking: Vec<&(String, String)> =
        branches.iter().filter(|(_, u)| *u == remote_ref).collect();
    let matching = tracking.iter().find(|(b, _)| b == name).copied();
    if matching.is_none() && tracking.len() > 1 {
        return Err(invalid(format!(
            "Multiple local branches track {reference}. Select the local branch to check out."
        )));
    }
    let existing = matching
        .or(tracking.first().copied())
        .or_else(|| branches.iter().find(|(b, _)| b == name));
    let sparse = |git, cwd| {
        prepare_windows_sparse(
            git,
            cwd,
            &remote_ref,
            allow_windows_sparse,
            expected_unsupported,
        )
    };

    let Some((local, upstream)) = existing else {
        sparse(git, cwd).await?;
        ensure_target_tree_supported(git, cwd, &remote_ref, "check out").await?;
        git.run(
            cwd,
            &["switch", "--track", "-c", name, "--", &remote_ref],
            RunOpts::default(),
        )
        .await?;
        return Ok(name.to_owned());
    };
    if !upstream.is_empty() && *upstream != remote_ref {
        return Err(invalid(format!(
            "Local branch {local} tracks a different remote branch. Select a local branch instead."
        )));
    }
    let local_ref = format!("refs/heads/{local}");
    ensure_not_checked_out_elsewhere(git, cwd, local).await?;
    let local_hash = git
        .run(
            cwd,
            &["rev-parse", "--verify", &local_ref],
            RunOpts::default(),
        )
        .await?
        .trim()
        .to_owned();
    let remote_hash = git
        .run(
            cwd,
            &["rev-parse", "--verify", &remote_ref],
            RunOpts::default(),
        )
        .await?
        .trim()
        .to_owned();
    let current = git
        .run(
            cwd,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            RunOpts::default(),
        )
        .await
        .unwrap_or_default();
    if local_hash == remote_hash && current.trim() == local {
        sparse(git, cwd).await?;
        return Ok(local.clone());
    }
    let behind = local_hash != remote_hash && is_ancestor(git, cwd, &local_ref, &remote_ref).await;
    if local_hash != remote_hash && !behind {
        let ahead = is_ancestor(git, cwd, &remote_ref, &local_ref).await;
        return Err(invalid(if ahead {
            format!("Cannot align {local} with {reference}: the local branch has commits that are not on the remote. They were preserved.")
        } else {
            format!("Cannot align {local} with {reference}: the branches have diverged. Local commits were preserved.")
        }));
    }
    sparse(git, cwd).await?;
    if behind {
        ensure_fast_forward_safe(git, cwd, local, &remote_ref).await?;
    } else {
        ensure_target_tree_supported(git, cwd, &remote_ref, "check out").await?;
    }
    git.run(cwd, &["switch", "--", local], RunOpts::default())
        .await?;
    if behind {
        git.run(
            cwd,
            &["merge", "--ff-only", &remote_ref],
            RunOpts::default(),
        )
        .await?;
    }
    if upstream.is_empty() {
        git.run(
            cwd,
            &["branch", &format!("--set-upstream-to={remote_ref}"), local],
            RunOpts::default(),
        )
        .await?;
    }
    Ok(local.clone())
}
