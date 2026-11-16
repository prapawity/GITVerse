//! Windows checkout safety (electron/git/git.ts): refuse to check out, reset to, or branch from a tree
//! whose file names Windows cannot create, unless sparse checkout already excludes them.
use std::path::Path;

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

/// Paths with a component Windows cannot create: reserved characters, a trailing dot or space,
/// or a reserved device name (CON, NUL, COM1, …).
pub fn windows_incompatible_paths(paths: &[String]) -> Vec<String> {
    const DEVICES: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let reserved_device = |part: &str| {
        let stem = part.split('.').next().unwrap_or_default().to_uppercase();
        if DEVICES.contains(&stem.as_str()) {
            return true;
        }
        let mut chars = stem.chars();
        let prefix: String = chars.by_ref().take(3).collect();
        let rest: String = chars.collect();
        (prefix == "COM" || prefix == "LPT")
            && rest.chars().count() == 1
            && rest
                .chars()
                .next()
                .is_some_and(|c| matches!(c, '1'..='9' | '¹' | '²' | '³'))
    };
    paths
        .iter()
        .filter(|p| {
            p.split('/').any(|part| {
                part.chars().any(|c| {
                    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20
                }) || part.ends_with(' ')
                    || part.ends_with('.')
                    || reserved_device(part)
            })
        })
        .cloned()
        .collect()
}

fn path_blocker(action: &str, reference: &str, paths: &[String]) -> String {
    let examples = paths
        .iter()
        .take(6)
        .map(|p| format!("'{p}'"))
        .collect::<Vec<_>>()
        .join("\n");
    let more = if paths.len() > 6 {
        format!("\n…and {} more.", paths.len() - 6)
    } else {
        String::new()
    };
    format!(
        "Cannot {action} {reference} on Windows because the target tree contains unsupported file names:\n{examples}{more}\nAsk the repository owner to rename these paths. No repository state was changed."
    )
}

pub fn sparse_exclude_pattern(path: &str) -> Result<String> {
    if path.contains(['\r', '\n', '\0']) {
        return Err(AppError::Invalid(
            "Cannot safely exclude a path containing a line break from sparse checkout.".into(),
        ));
    }
    let mut escaped = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let trimmed = escaped.trim_end_matches(' ');
    let spaces = escaped.len() - trimmed.len();
    Ok(format!("!/{trimmed}{}", "\\ ".repeat(spaces)))
}

async fn unsupported_tree_paths(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
) -> Result<Vec<String>> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let out = git
        .run(
            cwd,
            &["ls-tree", "-r", "-z", "--name-only", reference],
            RunOpts::default(),
        )
        .await?;
    let paths: Vec<String> = out
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(windows_incompatible_paths(&paths))
}

async fn sparse_patterns(git: &GitRunner, cwd: &Path) -> Result<Option<Vec<String>>> {
    let enabled = git
        .run(
            cwd,
            &["config", "--bool", "core.sparseCheckout"],
            RunOpts::default(),
        )
        .await
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !enabled {
        return Ok(None);
    }
    let info = git
        .run(
            cwd,
            &["rev-parse", "--git-path", "info/sparse-checkout"],
            RunOpts::default(),
        )
        .await?;
    let contents = std::fs::read_to_string(cwd.join(info.trim())).unwrap_or_default();
    let patterns: Vec<String> = contents
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    if patterns.is_empty() {
        return Err(AppError::Invalid(
            "Existing sparse-checkout rules could not be read. Review the repository sparse-checkout settings before continuing."
                .into(),
        ));
    }
    Ok(Some(patterns))
}

/// The unsupported paths that sparse checkout does not already exclude.
async fn sparse_unexcluded(git: &GitRunner, cwd: &Path, paths: Vec<String>) -> Result<Vec<String>> {
    if paths.is_empty() || !cfg!(windows) {
        return Ok(Vec::new());
    }
    // without sparse checkout nothing is excluded, so every unsupported path still blocks
    let Some(patterns) = sparse_patterns(git, cwd).await? else {
        return Ok(paths);
    };
    let mut kept = Vec::new();
    for path in paths {
        if !patterns.contains(&sparse_exclude_pattern(&path)?) {
            kept.push(path);
        }
    }
    Ok(kept)
}

pub async fn ensure_target_tree_supported(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
    action: &str,
) -> Result<()> {
    let all = unsupported_tree_paths(git, cwd, reference).await?;
    let unsupported = sparse_unexcluded(git, cwd, all).await?;
    if unsupported.is_empty() {
        Ok(())
    } else {
        Err(AppError::Invalid(path_blocker(
            action,
            reference,
            &unsupported,
        )))
    }
}

/// Resolve `reference` to a commit and run the Windows tree check on it (no-op elsewhere).
pub async fn preflight(git: &GitRunner, cwd: &Path, reference: &str, action: &str) -> Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let spec = format!("{reference}^{{commit}}");
    let target = git
        .run(
            cwd,
            &["rev-parse", "--verify", "--end-of-options", &spec],
            RunOpts::default(),
        )
        .await?;
    ensure_target_tree_supported(git, cwd, target.trim(), action).await
}

pub async fn windows_unsupported_paths_for_ref(
    git: &GitRunner,
    cwd: &Path,
    reference: &str,
) -> Result<Vec<String>> {
    match reference.find('/') {
        Some(i) if i >= 1 && i < reference.len() - 1 => {}
        _ => return Err(AppError::Invalid("Invalid remote branch.".into())),
    }
    let remote_ref = format!("refs/remotes/{reference}");
    git.run(
        cwd,
        &["show-ref", "--verify", "--quiet", &remote_ref],
        RunOpts::default(),
    )
    .await?;
    let paths = unsupported_tree_paths(git, cwd, &remote_ref).await?;
    sparse_unexcluded(git, cwd, paths).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_windows_incompatible_names() {
        let paths: Vec<String> = [
            "ok/file.txt",
            "assets/kit:bathroommirror.png",
            "docs/trailing./file.txt",
            "docs/CON.txt",
            "docs/com1",
            "docs/COM10.txt",
            "docs/console.txt",
            "tab\tname",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            windows_incompatible_paths(&paths),
            [
                "assets/kit:bathroommirror.png",
                "docs/trailing./file.txt",
                "docs/CON.txt",
                "docs/com1",
                "tab\tname"
            ]
        );
    }

    #[test]
    fn escapes_sparse_patterns() {
        assert_eq!(
            sparse_exclude_pattern("a*b[1].txt").unwrap(),
            "!/a\\*b\\[1\\].txt"
        );
        assert_eq!(sparse_exclude_pattern("name  ").unwrap(), "!/name\\ \\ ");
        assert!(sparse_exclude_pattern("bad\nname").is_err());
    }
}
