//! Discarding and (un)staging single hunks or whole files (electron/git/git.ts).
use std::path::Path;

use serde::Deserialize;

use super::index_history::{index_file, snapshot, IndexHistory};
use super::write::{conflicted, work_path};
use super::{op_state, status, working_file_diff, Area, GitRunner, RunOpts};
use crate::error::{AppError, Result};

fn invalid(m: &str) -> AppError {
    AppError::Invalid(m.to_owned())
}

/// Headers that mean the change is not a plain text edit and cannot be split into hunks.
fn whole_file_only(diff: &str) -> bool {
    const HEADERS: [&str; 10] = [
        "new file mode",
        "deleted file mode",
        "old mode",
        "new mode",
        "rename from",
        "rename to",
        "copy from",
        "copy to",
        "Binary files",
        "GIT binary patch",
    ];
    diff.lines()
        .any(|l| HEADERS.iter().any(|h| l.starts_with(h)))
}

/// Keep only the selected changed lines of one hunk (`selectHunkLines` in git.ts). Indices count
/// the hunk's ` `, `+` and `-` lines. An unselected line becomes context on the side the patch is
/// applied to: forward keeps a `-` as context and drops a `+`; reverse does the opposite. The
/// header keeps its start lines and `git apply --recount` recomputes the counts.
pub fn select_hunk_lines(hunk: &[&str], selected: &[i64], reverse: bool) -> Result<Vec<String>> {
    if selected.is_empty() || selected.iter().any(|n| *n < 0) {
        return Err(invalid("Select the lines to apply."));
    }
    let want: std::collections::HashSet<i64> = selected.iter().copied().collect();
    let Some((header, body)) = hunk.split_first() else {
        return Err(invalid(
            "This hunk is no longer available. Refresh the diff.",
        ));
    };
    let mut out = vec![(*header).to_owned()];
    let mut index: i64 = -1;
    let (mut changed, mut dropped) = (false, false);
    for line in body {
        if line.starts_with('\\') {
            if !dropped {
                out.push((*line).to_owned());
            }
            continue;
        }
        let sign = line.chars().next();
        if !matches!(sign, Some(' ' | '+' | '-')) {
            out.push((*line).to_owned());
            continue;
        }
        index += 1;
        dropped = false;
        if sign == Some(' ') || want.contains(&index) {
            changed |= sign != Some(' ');
            out.push((*line).to_owned());
        } else if (sign == Some('-')) != reverse {
            out.push(format!(" {}", &line[1..]));
        } else {
            dropped = true;
        }
    }
    if selected.iter().any(|n| *n > index) {
        return Err(invalid(
            "This selection is no longer available. Refresh the diff.",
        ));
    }
    if !changed {
        return Err(invalid("Select at least one added or removed line."));
    }
    Ok(out)
}

/// The diff header plus hunk `index` (optionally only `selected` lines), as a patch `git apply` accepts.
fn hunk_patch(diff: &str, index: i64, selected: Option<&[i64]>, reverse: bool) -> Result<String> {
    let lines: Vec<&str> = diff.split('\n').collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with("@@ "))
        .map(|(i, _)| i)
        .collect();
    let i = usize::try_from(index)
        .ok()
        .filter(|i| *i < starts.len())
        .ok_or_else(|| invalid("This hunk is no longer available. Refresh the diff."))?;
    let end = starts.get(i + 1).copied().unwrap_or(lines.len());
    let hunk: Vec<String> = match selected {
        Some(sel) => select_hunk_lines(&lines[starts[i]..end], sel, reverse)?,
        None => lines[starts[i]..end]
            .iter()
            .map(|l| (*l).to_owned())
            .collect(),
    };
    let mut patch = lines[..starts[0]]
        .iter()
        .map(|l| (*l).to_owned())
        .chain(hunk)
        .collect::<Vec<_>>()
        .join("\n");
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    Ok(patch)
}

/// Write the patch to a private temp file for `git apply`.
fn patch_file(patch: &str) -> Result<tempfile::TempPath> {
    let mut file = tempfile::Builder::new()
        .prefix("gitverse-hunk-")
        .suffix(".patch")
        .tempfile()?;
    std::io::Write::write_all(&mut file, patch.as_bytes())?;
    Ok(file.into_temp_path())
}

pub async fn discard_working_hunk(
    git: &GitRunner,
    cwd: &Path,
    path: &str,
    expected: &str,
    hunk: i64,
    selected: Option<&[i64]>,
) -> Result<()> {
    if op_state(git, cwd).await?.is_some() {
        return Err(invalid(
            "Finish or abort the current Git operation before discarding changes.",
        ));
    }
    let current = working_file_diff(git, cwd, path, Area::Unstaged).await?;
    if current != expected {
        return Err(invalid(
            "File changes changed since confirmation. Review the diff and try again.",
        ));
    }
    if whole_file_only(&current) {
        return Err(invalid("Discard this change as a whole file instead."));
    }
    let (_, full) = work_path(cwd, path)?;
    if !std::fs::symlink_metadata(&full)?.is_file() {
        return Err(invalid("Only regular text files support hunk discard."));
    }
    let patch = patch_file(&hunk_patch(&current, hunk, selected, true)?)?;
    let p = patch.to_string_lossy();
    git.run(
        cwd,
        &[
            "apply",
            "--reverse",
            "--recount",
            "--check",
            "--whitespace=nowarn",
            "--",
            &p,
        ],
        RunOpts::default(),
    )
    .await?;
    git.run(
        cwd,
        &[
            "apply",
            "--reverse",
            "--recount",
            "--whitespace=nowarn",
            "--",
            &p,
        ],
        RunOpts::default(),
    )
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)] // mirrors the IPC argument list of stageWorkingHunk
pub async fn stage_working_hunk(
    git: &GitRunner,
    history: &IndexHistory,
    cwd: &Path,
    path: &str,
    area: Area,
    expected: &str,
    hunk: i64,
    selected: Option<&[i64]>,
) -> Result<()> {
    if area == Area::Untracked {
        return Err(invalid("Invalid change area."));
    }
    if op_state(git, cwd).await?.is_some() {
        return Err(invalid("Finish or abort the current Git operation first."));
    }
    let current = working_file_diff(git, cwd, path, area).await?;
    if current != expected {
        return Err(invalid(
            "File changes changed since the diff was opened. Refresh and review them first.",
        ));
    }
    if whole_file_only(&current) {
        return Err(invalid(
            "Stage or unstage this change as a whole file instead.",
        ));
    }
    let patch_text = hunk_patch(&current, hunk, selected, area == Area::Staged)?;
    let file = index_file(git, cwd).await?;
    let before = snapshot(git, cwd, &file).await?;
    let patch = patch_file(&patch_text)?;
    let p = patch.to_string_lossy();
    let mut args = vec!["apply", "--cached"];
    if area == Area::Staged {
        args.push("--reverse");
    }
    args.extend(["--recount", "--whitespace=nowarn"]);
    let check: Vec<&str> = args.iter().copied().chain(["--check", "--", &p]).collect();
    git.run(cwd, &check, RunOpts::default()).await?;
    let apply: Vec<&str> = args.iter().copied().chain(["--", &p]).collect();
    git.run(cwd, &apply, RunOpts::default()).await?;
    let after = snapshot(git, cwd, &file).await?;
    history.record(cwd, before, after);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscardFile {
    pub path: String,
    pub area: Area,
    pub diff: String,
}

pub async fn discard_working_files(
    git: &GitRunner,
    cwd: &Path,
    files: &[DiscardFile],
) -> Result<()> {
    if files.is_empty() {
        return Err(invalid("Select files to discard."));
    }
    if op_state(git, cwd).await?.is_some() {
        return Err(invalid(
            "Finish or abort the current Git operation before discarding changes.",
        ));
    }
    let entries = status(git, cwd).await?;
    let (mut tracked, mut untracked, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    for file in files {
        if seen.contains(&file.path) {
            return Err(invalid("Invalid discard selection."));
        }
        seen.push(file.path.clone());
        let entry = entries.iter().find(|e| e.path == file.path);
        if entry.is_none_or(conflicted) || file.area == Area::Staged {
            return Err(invalid(
                "This file cannot be discarded. Refresh the working changes.",
            ));
        }
        if working_file_diff(git, cwd, &file.path, file.area).await? != file.diff {
            return Err(invalid(
                "File changes changed since confirmation. Review the diff and try again.",
            ));
        }
        if file.area == Area::Untracked {
            let (_, full) = work_path(cwd, &file.path)?;
            if std::fs::symlink_metadata(&full)?.is_dir() {
                return Err(invalid("Discarding directories is not supported."));
            }
            untracked.push(full);
        } else {
            tracked.push(file.path.as_str());
        }
    }
    if !tracked.is_empty() {
        let args: Vec<&str> = ["--literal-pathspecs", "ls-files", "--stage", "-z", "--"]
            .into_iter()
            .chain(tracked.iter().copied())
            .collect();
        let modes = git.run(cwd, &args, RunOpts::default()).await?;
        if modes.split('\0').any(|e| e.starts_with("160000 ")) {
            return Err(invalid(
                "Discard submodule changes inside the submodule repository.",
            ));
        }
        let args: Vec<&str> = ["--literal-pathspecs", "restore", "--worktree", "--"]
            .into_iter()
            .chain(tracked.iter().copied())
            .collect();
        git.run(cwd, &args, RunOpts::default()).await?;
    }
    for full in untracked {
        std::fs::remove_file(full)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::select_hunk_lines;

    const HUNK: [&str; 6] = [
        "@@ -1,4 +1,4 @@",
        " line 1",
        "-line 2",
        "-line 3",
        "+X2",
        "+X3",
    ];

    #[test]
    fn forward_keeps_unselected_deletions_as_context_and_drops_additions() {
        // indices: 0 ctx, 1 -line 2, 2 -line 3, 3 +X2, 4 +X3
        let out = select_hunk_lines(&HUNK, &[1, 3], false).unwrap();
        assert_eq!(
            out,
            ["@@ -1,4 +1,4 @@", " line 1", "-line 2", " line 3", "+X2"]
        );
    }

    #[test]
    fn reverse_keeps_unselected_additions_as_context_and_drops_deletions() {
        let out = select_hunk_lines(&HUNK, &[4], true).unwrap();
        assert_eq!(out, ["@@ -1,4 +1,4 @@", " line 1", " X2", "+X3"]);
    }

    #[test]
    fn refuses_empty_context_only_or_stale_selections() {
        assert!(select_hunk_lines(&HUNK, &[], false).is_err());
        assert!(select_hunk_lines(&HUNK, &[0], false).is_err());
        assert!(select_hunk_lines(&HUNK, &[9], false).is_err());
        assert!(select_hunk_lines(&HUNK, &[-1], false).is_err());
    }
}
