//! Git LFS, submodules, worktree remove/lock, patches, commit-range diffs, external tools and
//! maintenance. Mirrors the functions of the same names in electron/git/git.ts.
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

async fn run(git: &GitRunner, cwd: &Path, args: &[&str]) -> Result<String> {
    git.run(cwd, args, RunOpts::default()).await
}

// ---- Git LFS ----

#[derive(Debug, Serialize, Default)]
pub struct LfsStatus {
    pub installed: bool,
    pub used: bool,
    pub patterns: Vec<String>,
    pub files: Vec<String>,
}

pub async fn lfs_status(git: &GitRunner, cwd: &Path) -> Result<LfsStatus> {
    if !git.succeeds(cwd, &["lfs", "version"]).await {
        return Ok(LfsStatus::default());
    }
    let tracked = run(git, cwd, &["lfs", "track"]).await.unwrap_or_default();
    let patterns: Vec<String> = tracked
        .lines()
        .filter(|l| l.starts_with(char::is_whitespace))
        .filter_map(|l| l.trim().rsplit_once(" (").map(|(p, _)| p.to_owned()))
        .collect();
    let files: Vec<String> = run(git, cwd, &["lfs", "ls-files", "--name-only"])
        .await
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(5000)
        .map(str::to_owned)
        .collect();
    Ok(LfsStatus {
        installed: true,
        used: !patterns.is_empty() || !files.is_empty(),
        patterns,
        files,
    })
}

pub async fn lfs_action(
    git: &GitRunner,
    cwd: &Path,
    action: &str,
    pattern: Option<&str>,
) -> Result<String> {
    match action {
        "install" => run(git, cwd, &["lfs", "install", "--local"]).await,
        "pull" => run(git, cwd, &["lfs", "pull"]).await,
        "track" | "untrack" => {
            let p = pattern.map(str::trim).unwrap_or_default();
            if p.is_empty() || p.starts_with('-') || p.contains(['\r', '\n', '\0']) {
                return Err(invalid("Enter a file pattern such as *.psd."));
            }
            run(git, cwd, &["lfs", action, "--", p]).await
        }
        _ => Err(invalid("Unknown LFS action.")),
    }
}

// ---- submodules ----

#[derive(Debug, Serialize)]
pub struct Submodule {
    pub path: String,
    pub hash: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub describe: Option<String>,
}

fn parse_submodule(line: &str) -> Option<Submodule> {
    let mut chars = line.chars();
    let state = match chars.next()? {
        ' ' => "ok",
        '-' => "uninitialized",
        '+' => "modified",
        'U' => "conflict",
        _ => return None,
    };
    let rest = chars.as_str();
    let (hash, rest) = rest.split_once(' ')?;
    if !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let (path, describe) = match rest.rsplit_once(" (") {
        Some((p, d)) if d.ends_with(')') => (p, Some(d.trim_end_matches(')').to_owned())),
        _ => (rest, None),
    };
    Some(Submodule {
        path: path.to_owned(),
        hash: hash.to_owned(),
        state,
        describe,
    })
}

pub async fn submodules(git: &GitRunner, cwd: &Path) -> Result<Vec<Submodule>> {
    let out = run(git, cwd, &["submodule", "status", "--recursive"])
        .await
        .unwrap_or_default();
    Ok(out.lines().filter_map(parse_submodule).collect())
}

pub async fn submodule_update(git: &GitRunner, cwd: &Path, path: Option<&str>) -> Result<String> {
    let mut args = vec!["submodule", "update", "--init", "--recursive"];
    if let Some(p) = path {
        if p.is_empty() || p.starts_with('-') || p.contains('\0') {
            return Err(invalid("Invalid submodule path."));
        }
        args.extend(["--", p]);
    }
    run(git, cwd, &args).await
}

// ---- worktrees ----

async fn check_worktree(git: &GitRunner, cwd: &Path, wt: &str) -> Result<()> {
    let list = run(git, cwd, &["worktree", "list", "--porcelain"]).await?;
    let paths: Vec<&str> = list
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .collect();
    if !paths.contains(&wt) {
        return Err(invalid("That worktree is not part of this repository."));
    }
    if paths.first() == Some(&wt) {
        return Err(invalid(
            "The main worktree cannot be removed or locked here.",
        ));
    }
    Ok(())
}

pub async fn worktree_remove(
    git: &GitRunner,
    cwd: &Path,
    wt: &str,
    force: bool,
    delete_branch: Option<&str>,
) -> Result<String> {
    check_worktree(git, cwd, wt).await?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(wt);
    run(git, cwd, &args).await?;
    if let Some(branch) = delete_branch.filter(|b| !b.is_empty()) {
        if branch.starts_with('-') {
            return Err(invalid("Invalid branch."));
        }
        run(
            git,
            cwd,
            &["branch", if force { "-D" } else { "-d" }, branch],
        )
        .await?;
    }
    Ok(String::new())
}

pub async fn worktree_lock(git: &GitRunner, cwd: &Path, wt: &str, lock: bool) -> Result<String> {
    check_worktree(git, cwd, wt).await?;
    run(
        git,
        cwd,
        &["worktree", if lock { "lock" } else { "unlock" }, wt],
    )
    .await
}

// ---- patches ----

pub async fn apply_patch(git: &GitRunner, cwd: &Path, patch: &str, mode: &str) -> Result<String> {
    if patch.trim().is_empty() {
        return Err(invalid("The patch is empty."));
    }
    if patch.len() > 20 * 1024 * 1024 {
        return Err(invalid("The patch is too large."));
    }
    let args: &[&str] = match mode {
        "check" => &["apply", "--check", "-"],
        "am" => &["am", "--3way"],
        "apply" => &["apply", "--3way", "-"],
        _ => return Err(invalid("Unknown patch mode.")),
    };
    let opts = RunOpts {
        stdin: Some(patch.to_owned()),
        ..RunOpts::default()
    };
    match git.run(cwd, args, opts).await {
        // never leave the repository in the middle of an am the app cannot continue
        Err(e) if mode == "am" => {
            let _ = run(git, cwd, &["am", "--abort"]).await;
            Err(invalid(format!("{e}\nNothing was applied.")))
        }
        other => other,
    }
}

// ---- combined diff of a commit range ----

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn check_hash(h: &str) -> Result<()> {
    if (7..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(invalid("Invalid commit ID."))
    }
}

async fn range_base(git: &GitRunner, cwd: &Path, oldest: &str) -> Result<String> {
    check_hash(oldest)?;
    let parent = format!("{oldest}^");
    Ok(
        match run(git, cwd, &["rev-parse", "--verify", "--quiet", &parent]).await {
            Ok(h) if !h.trim().is_empty() => h.trim().to_owned(),
            _ => EMPTY_TREE.to_owned(),
        },
    )
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeFile {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

pub async fn range_files(
    git: &GitRunner,
    cwd: &Path,
    oldest: &str,
    newest: &str,
) -> Result<Vec<RangeFile>> {
    check_hash(newest)?;
    let base = range_base(git, cwd, oldest).await?;
    let out = run(
        git,
        cwd,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            &base,
            newest,
        ],
    )
    .await?;
    let parts: Vec<&str> = out.split('\0').filter(|p| !p.is_empty()).collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i + 1 < parts.len() {
        let status = parts[i].chars().next().unwrap_or('M').to_string();
        let first = parts[i + 1].to_owned();
        i += 2;
        if (status == "R" || status == "C") && i < parts.len() {
            files.push(RangeFile {
                status,
                path: parts[i].to_owned(),
                old_path: Some(first),
            });
            i += 1;
        } else {
            files.push(RangeFile {
                status,
                path: first,
                old_path: None,
            });
        }
    }
    Ok(files)
}

pub async fn range_file_diff(
    git: &GitRunner,
    cwd: &Path,
    oldest: &str,
    newest: &str,
    file: &str,
    old_path: Option<&str>,
) -> Result<String> {
    check_hash(newest)?;
    let base = range_base(git, cwd, oldest).await?;
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--find-renames",
        &base,
        newest,
        "--",
    ];
    if let Some(old) = old_path {
        args.push(old);
    }
    args.push(file);
    run(git, cwd, &args).await
}

pub async fn range_patch(
    git: &GitRunner,
    cwd: &Path,
    oldest: &str,
    newest: &str,
) -> Result<String> {
    check_hash(newest)?;
    let base = range_base(git, cwd, oldest).await?;
    run(
        git,
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--binary",
            &base,
            newest,
        ],
    )
    .await
}

// ---- external tools and maintenance ----

pub async fn external_tool(
    git: &GitRunner,
    cwd: &Path,
    tool: &str,
    file: &str,
    staged: bool,
) -> Result<String> {
    if file.is_empty() || file.starts_with('-') || file.contains('\0') {
        return Err(invalid("Invalid file."));
    }
    let key = match tool {
        "diff" => "diff.tool",
        "merge" => "merge.tool",
        _ => return Err(invalid("Unknown tool.")),
    };
    let configured = run(git, cwd, &["config", "--get", key])
        .await
        .unwrap_or_default();
    if configured.trim().is_empty() {
        return Err(invalid(format!(
            "No external {tool} tool is configured. Choose one in Settings → External tools (git config {key})."
        )));
    }
    let mut args: Vec<&str> = if tool == "diff" {
        vec!["difftool", "-y", "--no-prompt"]
    } else {
        vec!["mergetool", "--no-prompt"]
    };
    if tool == "diff" && staged {
        args.push("--cached");
    }
    args.extend(["--", file]);
    // runs on its own; the tool window stays open after this returns
    std::process::Command::new("git")
        .args(&args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| invalid(format!("Could not start Git: {e}")))?;
    Ok(String::new())
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ToolConfig {
    pub diff: String,
    pub merge: String,
}

pub async fn external_tool_config(git: &GitRunner, cwd: &Path) -> Result<ToolConfig> {
    let get = |key: &'static str| async move {
        run(git, cwd, &["config", "--get", key])
            .await
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let (diff, merge) = tokio::join!(get("diff.tool"), get("merge.tool"));
    Ok(ToolConfig { diff, merge })
}

fn tool_name_ok(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub async fn set_external_tool_config(
    git: &GitRunner,
    cwd: &Path,
    config: ToolConfig,
) -> Result<String> {
    for (key, value) in [("diff.tool", &config.diff), ("merge.tool", &config.merge)] {
        if value.is_empty() {
            let _ = run(git, cwd, &["config", "--global", "--unset-all", key]).await;
        } else if !tool_name_ok(value) {
            return Err(invalid(format!("\"{value}\" is not a valid tool name.")));
        } else {
            run(git, cwd, &["config", "--global", key, value]).await?;
        }
    }
    Ok(String::new())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub before_ki_b: u64,
    pub after_ki_b: u64,
}

async fn object_size(git: &GitRunner, cwd: &Path) -> Result<u64> {
    let out = run(git, cwd, &["count-objects", "-v"]).await?;
    let n = |key: &str| {
        out.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}: ")))
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0)
    };
    Ok(n("size") + n("size-pack"))
}

pub async fn maintenance(git: &GitRunner, cwd: &Path) -> Result<MaintenanceResult> {
    let before = object_size(git, cwd).await?;
    run(git, cwd, &["gc", "--quiet"]).await?;
    let _ = run(git, cwd, &["commit-graph", "write", "--reachable"]).await;
    let after = object_size(git, cwd).await?;
    Ok(MaintenanceResult {
        before_ki_b: before,
        after_ki_b: after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn agent_worktrees_stay_in_the_agents_folder() {
        let git = GitRunner::default();
        let repo = Path::new("/nonexistent/gitverse/app");
        for bad in [
            "/tmp/elsewhere/fix",
            "/nonexistent/gitverse/app.agents/a/b",
            "/nonexistent/gitverse/other.agents/fix",
        ] {
            let err = worktree_add_branch(&git, repo, bad, "agent/x", "main")
                .await
                .unwrap_err();
            assert!(
                err.to_string().contains("must be created in"),
                "{bad}: {err}"
            );
        }
    }

    #[test]
    fn parses_submodule_status_lines() {
        let s = parse_submodule("-1234abcd libs/one").unwrap();
        assert_eq!((s.state, s.path.as_str()), ("uninitialized", "libs/one"));
        let s = parse_submodule("+abcdef12 libs/two (v1.2-3-gabc)").unwrap();
        assert_eq!(s.state, "modified");
        assert_eq!(s.describe.as_deref(), Some("v1.2-3-gabc"));
        assert!(parse_submodule("x junk").is_none());
        assert!(tool_name_ok("vscode") && !tool_name_ok("rm -rf"));
    }
}

// ---- material for AI explanations (`branchDiff` / `workingDiff` in git.ts) ----

const AI_LIMIT: usize = 140_000;
fn clip(text: String) -> String {
    if text.len() <= AI_LIMIT {
        return text;
    }
    let mut end = AI_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

#[derive(Debug, Serialize)]
pub struct BranchDiff {
    pub commits: String,
    pub diff: String,
}

pub async fn branch_diff(
    git: &GitRunner,
    cwd: &Path,
    base: &str,
    branch: &str,
) -> Result<BranchDiff> {
    for r in [base, branch] {
        if r.is_empty() || r.starts_with('-') || r.chars().any(char::is_whitespace) {
            return Err(invalid("Invalid branch."));
        }
    }
    let range = format!("{base}..{branch}");
    let sym = format!("{base}...{branch}");
    let log_args = ["log", "--no-merges", "--format=- %s", range.as_str(), "--"];
    let diff_args = [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--find-renames",
        sym.as_str(),
        "--",
    ];
    let (log, diff) = tokio::join!(run(git, cwd, &log_args), run(git, cwd, &diff_args));
    Ok(BranchDiff {
        commits: log?.trim().to_owned(),
        diff: clip(diff?),
    })
}

#[derive(Debug, Serialize)]
pub struct WorkingDiff {
    pub diff: String,
    pub untracked: Vec<String>,
}

pub async fn working_diff(git: &GitRunner, cwd: &Path) -> Result<WorkingDiff> {
    let has_head = git.succeeds(cwd, &["rev-parse", "--verify", "HEAD"]).await;
    let diff = if has_head {
        run(
            git,
            cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "HEAD",
                "--",
            ],
        )
        .await?
    } else {
        run(
            git,
            cwd,
            &["diff", "--no-ext-diff", "--no-color", "--cached", "--"],
        )
        .await?
    };
    let untracked = run(git, cwd, &["ls-files", "--others", "--exclude-standard"])
        .await?
        .lines()
        .filter(|l| !l.is_empty())
        .take(200)
        .map(str::to_owned)
        .collect();
    Ok(WorkingDiff {
        diff: clip(diff),
        untracked,
    })
}

/// Create `branch` at `base` and check it out in a new worktree at `path` (`worktreeAddBranch` in git.ts).
pub async fn worktree_add_branch(
    git: &GitRunner,
    cwd: &Path,
    path: &str,
    branch: &str,
    base: &str,
) -> Result<String> {
    let target = Path::new(path);
    if !target.is_absolute() || path.contains('\0') {
        return Err(invalid("Choose an absolute folder for the worktree."));
    }
    // Agent worktrees live only in `<parent>/<repo>.agents/` (agentWorktreePath), never anywhere else.
    let agents_dir = match (cwd.parent(), cwd.file_name()) {
        (Some(parent), Some(name)) => parent.join(format!("{}.agents", name.to_string_lossy())),
        _ => return Err(invalid("Choose an absolute folder for the worktree.")),
    };
    if target.parent() != Some(agents_dir.as_path()) || target.file_name().is_none() {
        return Err(invalid(format!(
            "Agent worktrees must be created in {}.",
            agents_dir.display()
        )));
    }
    if target.exists() {
        return Err(invalid(format!("{path} already exists.")));
    }
    if base.is_empty() || base.starts_with('-') {
        return Err(invalid("Choose a base branch."));
    }
    if branch.trim().is_empty() || branch.starts_with('-') {
        return Err(invalid("Enter a branch name."));
    }
    if !git
        .succeeds(cwd, &["check-ref-format", "--branch", branch])
        .await
    {
        return Err(invalid(format!("\"{branch}\" is not a valid branch name.")));
    }
    super::not_option("worktree path", path)?;
    super::not_option("base", base)?;
    let commit = format!("{base}^{{commit}}");
    if !git
        .succeeds(cwd, &["rev-parse", "--verify", "--quiet", &commit])
        .await
    {
        return Err(invalid(format!("Base \"{base}\" was not found.")));
    }
    run(git, cwd, &["worktree", "add", "-b", branch, path, base]).await
}
