//! Find Git repositories under a dropped or chosen folder (port of electron/repositoryScan.ts).
//! Hidden and dependency folders are skipped, directory symlinks are not followed, and a folder only
//! counts when it is the top level of its own repository (worktrees included).
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

const EXCLUDED: [&str; 4] = ["node_modules", "vendor", "dist", "build"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanProgress {
    pub scanned: u64,
    pub repositories: u64,
    pub skipped: u64,
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanResult {
    pub root: String,
    pub group: String,
    pub repos: Vec<String>,
    pub skipped: u64,
    pub cancelled: bool,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// `git rev-parse --show-toplevel` in `dir`, compared with `dir` itself after resolving links.
async fn is_top_level(dir: &Path, cancel: &CancellationToken) -> Result<bool, ()> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::select! {
        o = tokio::time::timeout(Duration::from_secs(10), cmd.output()) => o.map_err(|_| ())?.map_err(|_| ())?,
        _ = cancel.cancelled() => return Err(()),
    };
    if !out.status.success() {
        return Err(());
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let a = std::fs::canonicalize(&top).map_err(|_| ())?;
    let b = std::fs::canonicalize(dir).map_err(|_| ())?;
    Ok(a == b)
}

pub async fn scan_repositories(
    folder: &str,
    cancel: &CancellationToken,
    on_progress: impl Fn(ScanProgress),
) -> Result<ScanResult, String> {
    let root = PathBuf::from(folder);
    if folder.contains('\0') || !root.is_absolute() {
        return Err("Choose a valid folder.".into());
    }
    let root: PathBuf = root.components().collect();
    let mut pending = vec![root.clone()];
    let (mut repos, mut scanned, mut skipped) = (Vec::new(), 0u64, 0u64);
    let mut current = root.clone();
    let mut last = Instant::now();
    let report = |current: &Path, scanned, repos: &Vec<String>, skipped| {
        on_progress(ScanProgress {
            scanned,
            repositories: repos.len() as u64,
            skipped,
            folder: s(current),
        })
    };
    report(&current, scanned, &repos, skipped);
    while !cancel.is_cancelled() {
        let Some(next) = pending.pop() else { break };
        current = next;
        let mut entries = Vec::new();
        match tokio::fs::read_dir(&current).await {
            Ok(mut rd) => {
                while let Ok(Some(e)) = rd.next_entry().await {
                    // file_type() does not follow symlinks, like Node's Dirent
                    if let Ok(t) = e.file_type().await {
                        entries.push((e.file_name().to_string_lossy().into_owned(), t));
                    }
                }
            }
            Err(e) if current == root => {
                return Err(format!("Could not read the dropped folder: {e}"))
            }
            Err(_) => {
                skipped += 1;
                continue;
            }
        }
        if cancel.is_cancelled() {
            break;
        }
        scanned += 1;
        if entries
            .iter()
            .any(|(n, t)| n == ".git" && (t.is_dir() || t.is_file()))
        {
            match is_top_level(&current, cancel).await {
                Ok(true) => repos.push(s(&current)),
                Ok(false) => {}
                Err(()) if cancel.is_cancelled() => break,
                Err(()) => skipped += 1,
            }
        }
        for (name, t) in &entries {
            if t.is_dir() && !name.starts_with('.') && !EXCLUDED.contains(&name.as_str()) {
                pending.push(current.join(name));
            }
        }
        if last.elapsed() >= Duration::from_millis(150) {
            report(&current, scanned, &repos, skipped);
            last = Instant::now();
        }
    }
    report(&current, scanned, &repos, skipped);
    Ok(ScanResult {
        group: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| s(&root)),
        root: s(&root),
        repos,
        skipped,
        cancelled: cancel.is_cancelled(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(args: &[&str]) {
        assert!(Command::new("git").args(args).status().unwrap().success());
    }

    async fn scan(root: &Path) -> Result<ScanResult, String> {
        scan_repositories(&s(root), &CancellationToken::new(), |_| {}).await
    }

    #[tokio::test]
    async fn finds_deep_repositories_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..300 {
            std::fs::create_dir(dir.path().join(format!("folder-{i}"))).unwrap();
        }
        let mut deep = dir.path().join("folder-0");
        for i in 0..8 {
            deep = deep.join(format!("level-{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        git(&["init", "--quiet", &s(&deep)]);
        let progress = std::sync::Mutex::new(Vec::new());
        let r = scan_repositories(&s(dir.path()), &CancellationToken::new(), |p| {
            progress.lock().unwrap().push(p)
        })
        .await
        .unwrap();
        assert_eq!(r.repos, [s(&deep)]);
        assert!(!r.cancelled);
        assert_eq!(r.skipped, 0);
        let last = progress.lock().unwrap().last().cloned().unwrap();
        assert!(last.scanned > 300);
        assert_eq!(last.repositories, 1);
    }

    #[tokio::test]
    async fn skips_hidden_and_dependency_folders_finds_worktrees_counts_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = root.join("repo");
        git(&["init", "--quiet", &s(&repo)]);
        git(&[
            "-C",
            &s(&repo),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "Initial",
        ]);
        let wt = root.join("worktree");
        git(&[
            "-C",
            &s(&repo),
            "worktree",
            "add",
            "--quiet",
            "--detach",
            &s(&wt),
        ]);
        for name in [".hidden", "node_modules", "vendor", "dist", "build"] {
            git(&["init", "--quiet", &s(&root.join(name).join("ignored"))]);
        }
        std::fs::create_dir(root.join("invalid")).unwrap();
        std::fs::write(root.join("invalid").join(".git"), "not a git directory").unwrap();
        let mut r = scan(root).await.unwrap();
        r.repos.sort();
        let mut want = vec![s(&repo), s(&wt)];
        want.sort();
        assert_eq!(r.repos, want);
        assert_eq!(r.skipped, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("cycle")).unwrap();
        let r = scan(dir.path()).await.unwrap();
        assert!(r.repos.is_empty() && !r.cancelled);
    }

    #[tokio::test]
    async fn honors_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let c = cancel.clone();
        let r = scan_repositories(&s(dir.path()), &cancel, move |_| c.cancel())
            .await
            .unwrap();
        assert!(r.cancelled && r.repos.is_empty());
    }

    #[tokio::test]
    async fn rejects_invalid_input_and_unreadable_roots() {
        assert_eq!(
            scan(Path::new("relative/path")).await.unwrap_err(),
            "Choose a valid folder."
        );
        let dir = tempfile::tempdir().unwrap();
        let e = scan(&dir.path().join("missing")).await.unwrap_err();
        assert!(e.starts_with("Could not read the dropped folder"), "{e}");
    }
}
