//! Commit Composer: `commit_files` commits exactly the chosen paths (mirrors electron/git/extras.test.ts).
use std::process::Command;

use gitverse_core::git::{self, GitRunner};

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[tokio::test]
async fn commit_files_commits_exactly_the_chosen_files() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    for (f, t) in [("keep.txt", "k\n"), ("gone.txt", "g\n"), ("old.txt", "o\n")] {
        std::fs::write(d.join(f), t).unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "first"]);
    git(d, &["rm", "-q", "gone.txt"]);
    git(d, &["mv", "old.txt", "new.txt"]);
    std::fs::write(d.join("fresh.txt"), "f\n").unwrap();
    std::fs::write(d.join("keep.txt"), "k2\n").unwrap();
    git(d, &["add", "keep.txt"]);

    let runner = GitRunner::default();
    let paths: Vec<String> = ["gone.txt", "new.txt", "fresh.txt"]
        .map(String::from)
        .to_vec();
    git::commit_files(&runner, d, &paths, "refactor: tidy files", "body")
        .await
        .unwrap();
    assert_eq!(
        git(d, &["log", "-1", "--format=%s|%b"]).trim(),
        "refactor: tidy files|body"
    );
    let files = git(d, &["show", "--name-status", "--format=", "HEAD"]);
    assert!(
        files.contains("D\tgone.txt") && files.contains("A\tfresh.txt"),
        "{files}"
    );
    assert!(!files.contains("keep.txt"), "{files}");
    assert!(git(d, &["status", "--porcelain"]).contains("M  keep.txt"));
    assert!(git::commit_files(&runner, d, &["nope.txt".into()], "x", "")
        .await
        .is_err());
    assert!(git::commit_files(&runner, d, &["keep.txt".into()], " ", "")
        .await
        .is_err());
}
