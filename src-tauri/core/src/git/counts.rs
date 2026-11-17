//! `fileChangeCounts`: added+removed lines per working-tree file, staged and unstaged.
use std::collections::HashMap;
use std::path::{Component, Path};

use serde::Serialize;

use super::{status, GitRunner, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileChangeCount {
    pub path: String,
    /// `None` (JSON null) for binary files or directories.
    pub staged: Option<u64>,
    pub unstaged: Option<u64>,
}

/// Parse `diff --numstat -z`. Renames have an empty path, then old and new path records.
pub fn parse_numstat(text: &str) -> HashMap<String, Option<u64>> {
    let records: Vec<&str> = text.split('\0').collect();
    let mut counts = HashMap::new();
    let mut i = 0;
    while i < records.len() {
        let mut fields = records[i].splitn(3, '\t');
        let (added, removed, path) = (fields.next(), fields.next(), fields.next());
        let num = |s: &str| s == "-" || (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if let (Some(a), Some(r), Some(p)) = (added, removed, path) {
            if num(a) && num(r) {
                let path = if p.is_empty() {
                    i += 2; // skip the old path, take the new one
                    records.get(i).copied().unwrap_or_default()
                } else {
                    p
                };
                if !path.is_empty() {
                    let value = match (a.parse::<u64>(), r.parse::<u64>()) {
                        (Ok(a), Ok(r)) => Some(a + r),
                        _ => None,
                    };
                    counts.insert(path.to_owned(), value);
                }
            }
        }
        i += 1;
    }
    counts
}

/// Repository-relative path that cannot escape the repository.
fn inside(root: &Path, rel: &str) -> Result<std::path::PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(AppError::Invalid("Path is outside the repository".into()));
    }
    Ok(root.join(rel_path))
}

pub async fn file_change_counts(git: &GitRunner, cwd: &Path) -> Result<Vec<FileChangeCount>> {
    let files = status(git, cwd).await?;
    let base = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"];
    let staged_args: Vec<&str> = base.iter().copied().chain(["--cached", "--"]).collect();
    let unstaged_args: Vec<&str> = base.iter().copied().chain(["--"]).collect();
    let (staged, unstaged) = tokio::join!(
        git.run(cwd, &staged_args, RunOpts::default()),
        git.run(cwd, &unstaged_args, RunOpts::default())
    );
    let staged = parse_numstat(&staged?);
    let mut unstaged = parse_numstat(&unstaged?);

    for file in files.iter().filter(|f| f.index == "?" && f.worktree == "?") {
        let full = inside(cwd, &file.path)?;
        if std::fs::symlink_metadata(&full)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            unstaged.insert(file.path.clone(), None);
            continue;
        }
        let args = [
            "diff",
            "--numstat",
            "-z",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            "/dev/null",
            &file.path,
        ];
        let out = git
            .run(
                cwd,
                &args,
                RunOpts {
                    no_identity: true,
                    ..RunOpts::default()
                }
                .ok_code(1),
            )
            .await?;
        let value = match parse_numstat(&out).remove(&file.path) {
            Some(v) => v,
            None if out.is_empty() => Some(0),
            None => None,
        };
        unstaged.insert(file.path.clone(), value);
    }

    Ok(files
        .into_iter()
        .map(|f| FileChangeCount {
            staged: staged.get(&f.path).copied().unwrap_or(Some(0)),
            unstaged: unstaged.get(&f.path).copied().unwrap_or(Some(0)),
            path: f.path,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numstat_with_binary_and_renames() {
        let c = parse_numstat(concat!(
            "3\t1\ta.txt\0-\t-\tlogo.png\0",
            "2\t0\t\0old.txt\0new.txt\0"
        ));
        assert_eq!(c.get("a.txt"), Some(&Some(4)));
        assert_eq!(c.get("logo.png"), Some(&None));
        assert_eq!(c.get("new.txt"), Some(&Some(2)));
        assert!(!c.contains_key("old.txt"));
    }

    #[test]
    fn rejects_paths_outside_the_repository() {
        assert!(inside(Path::new("/repo"), "../etc/passwd").is_err());
        assert!(inside(Path::new("/repo"), "src/a.txt").is_ok());
    }
}
