//! `commitDetail`, `commitFileDiff`, `workingFileDiff` from electron/git/git.ts.
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{status, GitRunner, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitDetail {
    pub body: String,
    pub files: Vec<ChangedFile>,
}

/// Parse `show --name-status -z`: renames/copies carry old then new path.
pub fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let status = code.chars().next().unwrap_or(' ').to_string();
        let first = parts.next().unwrap_or_default().to_owned();
        if status == "R" || status == "C" {
            let path = parts.next().unwrap_or_default().to_owned();
            files.push(ChangedFile {
                status,
                path,
                old_path: Some(first),
            });
        } else {
            files.push(ChangedFile {
                status,
                path: first,
                old_path: None,
            });
        }
    }
    files
}

pub async fn commit_detail(git: &GitRunner, cwd: &Path, hash: &str) -> Result<CommitDetail> {
    let body = git
        .run(
            cwd,
            &["show", "-s", "--format=%B", hash],
            RunOpts::default(),
        )
        .await?
        .trim()
        .to_owned();
    let out = git
        .run(
            cwd,
            &[
                "show",
                "--name-status",
                "-z",
                "--format=",
                "--first-parent",
                hash,
            ],
            RunOpts::default(),
        )
        .await?;
    Ok(CommitDetail {
        body,
        files: parse_name_status(&out),
    })
}

pub async fn commit_file_diff(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<String> {
    let mut args = vec![
        "--literal-pathspecs",
        "show",
        "--first-parent",
        "--format=",
        "--no-ext-diff",
        "--no-color",
        hash,
        "--",
    ];
    args.extend(old_path);
    args.push(path);
    git.run(cwd, &args, RunOpts::default()).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    Staged,
    Unstaged,
    Untracked,
}

pub async fn working_file_diff(
    git: &GitRunner,
    cwd: &Path,
    file_path: &str,
    area: Area,
) -> Result<String> {
    let gone = || {
        AppError::Invalid("This file is no longer in the working changes. Refresh the list.".into())
    };
    let file = status(git, cwd)
        .await?
        .into_iter()
        .find(|f| f.path == file_path)
        .ok_or_else(gone)?;
    if area == Area::Untracked {
        if file.index != "?" || file.worktree != "?" {
            return Err(AppError::Invalid(
                "This file is no longer untracked. Refresh the list.".into(),
            ));
        }
        let args = [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            "/dev/null",
            file_path,
        ];
        return git
            .run(
                cwd,
                &args,
                RunOpts {
                    no_identity: true,
                    ..RunOpts::default()
                }
                .ok_code(1),
            )
            .await;
    }
    let state = if area == Area::Staged {
        &file.index
    } else {
        &file.worktree
    };
    if state == " " || state == "?" {
        return Err(AppError::Invalid(
            "This change is no longer available. Refresh the list.".into(),
        ));
    }
    let mut args = vec!["--literal-pathspecs", "diff"];
    if area == Area::Staged {
        args.push("--cached");
    }
    args.extend(["--no-ext-diff", "--no-textconv", "--no-color", "--"]);
    if area == Area::Staged {
        args.extend(file.old_path.as_deref());
    }
    args.push(file_path);
    git.run(cwd, &args, RunOpts::default()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renames_as_old_then_new() {
        let files = parse_name_status("R100\0old.txt\0new.txt\0M\0a.txt\0");
        assert_eq!(
            files[0],
            ChangedFile {
                status: "R".into(),
                path: "new.txt".into(),
                old_path: Some("old.txt".into())
            }
        );
        assert_eq!(files[1].path, "a.txt");
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Person {
    pub name: String,
    pub email: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitPeople {
    pub author: Person,
    pub committer: Person,
}

/// Author and committer of a commit (`commitPeople` in git.ts).
pub async fn commit_people(git: &GitRunner, cwd: &Path, hash: &str) -> Result<CommitPeople> {
    let ok = hash == "HEAD"
        || ((7..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit()));
    if !ok {
        return Err(crate::error::AppError::Invalid("Invalid commit ID.".into()));
    }
    let out = git
        .run(
            cwd,
            &[
                "show",
                "-s",
                "--format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI",
                hash,
            ],
            RunOpts::default(),
        )
        .await?;
    let f: Vec<&str> = out.trim().split('\u{1f}').collect();
    let at = |i: usize| f.get(i).copied().unwrap_or_default().to_owned();
    Ok(CommitPeople {
        author: Person {
            name: at(0),
            email: at(1),
            date: at(2),
        },
        committer: Person {
            name: at(3),
            email: at(4),
            date: at(5),
        },
    })
}
