use std::path::Path;

use serde::Serialize;

use super::{GitRunner, RunOpts};
use crate::error::Result;

/// Same shape as `FileStatus` in src/shared/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub index: String,
    pub worktree: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// Parse `git status --porcelain=v1 -z`. Renames/copies carry their original path as the next entry.
pub fn parse_status(out: &str) -> Vec<FileStatus> {
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = parts.next() {
        let mut chars = entry.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        // "XY path": the path starts after the two status chars and a space
        let path = entry.get(3..).unwrap_or_default().to_owned();
        let old_path = if x == 'R' || x == 'C' {
            parts.next().map(str::to_owned)
        } else {
            None
        };
        files.push(FileStatus {
            index: x.to_string(),
            worktree: y.to_string(),
            path,
            old_path,
        });
    }
    files
}

pub async fn status(git: &GitRunner, cwd: &Path) -> Result<Vec<FileStatus>> {
    let out = git
        .run(
            cwd,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            RunOpts::default(),
        )
        .await?;
    Ok(parse_status(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renames_with_original_path() {
        let files = parse_status("R  new.txt\0old.txt\0 M a b.txt\0?? ไฟล์.md\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].worktree, "M");
        assert_eq!(files[1].path, "a b.txt");
        assert_eq!(files[2].path, "ไฟล์.md");
    }

    #[test]
    fn empty_output_is_clean_tree() {
        assert!(parse_status("").is_empty());
    }
}
