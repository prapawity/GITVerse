//! Rust side of electron/git/contract.golden.test.ts: rebuild the same deterministic repository
//! and require byte-for-byte the same JSON as fixtures/git-contract/*.json.
use std::path::{Path, PathBuf};
use std::process::Command;

use gitverse_core::git::{self, GitRunner};

struct Repo {
    dir: tempfile::TempDir,
    clock: std::cell::Cell<u64>,
}

impl Repo {
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn git(&self, args: &[&str]) -> String {
        self.clock.set(self.clock.get() + 60);
        let date = format!("{} +0700", self.clock.get());
        let out = Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
                "-c",
                "core.autocrlf=false",
            ])
            .args(args)
            .current_dir(self.path())
            .env("GIT_AUTHOR_NAME", "Ada Lovelace")
            .env("GIT_AUTHOR_EMAIL", "ada@example.com")
            .env("GIT_COMMITTER_NAME", "Ada Lovelace")
            .env("GIT_COMMITTER_EMAIL", "ada@example.com")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", self.path())
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }
    fn put(&self, file: &str, text: &str) {
        std::fs::write(self.path().join(file), text).unwrap();
    }
}

/// Must stay identical to buildRepo() in electron/git/contract.golden.test.ts.
fn build_repo() -> Repo {
    let repo = Repo {
        dir: tempfile::tempdir().unwrap(),
        clock: 1_700_000_000.into(),
    };
    repo.git(&["init", "--quiet", "--initial-branch=main"]);
    repo.put("README.md", "# Demo\n\nline one\n");
    repo.put("app.txt", "alpha\nbeta\ngamma\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "--quiet", "-m", "Initial commit"]);
    repo.put("app.txt", "alpha\nbeta changed\ngamma\ndelta\n");
    repo.git(&[
        "commit",
        "--quiet",
        "-am",
        "Change app\n\nLonger body line.",
    ]);
    repo.git(&["tag", "v1.0.0"]);
    repo.git(&["tag", "-a", "v1.0.1", "-m", "Annotated release"]);
    repo.git(&["checkout", "--quiet", "-b", "feature/login"]);
    repo.put("login.txt", "login form\n");
    repo.git(&["add", "login.txt"]);
    repo.git(&["commit", "--quiet", "-m", "Add login"]);
    repo.git(&["checkout", "--quiet", "main"]);
    repo.put("README.md", "# Demo\n\nline one\nline two\n");
    repo.git(&["commit", "--quiet", "-am", "Update readme"]);
    repo.git(&[
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "Merge branch 'feature/login'",
        "feature/login",
    ]);
    repo.put("app.txt", "alpha\nstashed\n");
    repo.git(&["stash", "push", "--quiet", "-m", "wip on app"]);
    repo.put("login.txt", "login form\nremember me\n");
    repo.git(&["add", "login.txt"]);
    repo.put("app.txt", "alpha\nbeta changed\ngamma\ndelta\nepsilon\n");
    repo.put("notes.md", "todo\n");
    std::fs::remove_file(repo.path().join("README.md")).unwrap();
    repo
}

fn fixture(name: &str) -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "fixtures",
        "git-contract",
        &format!("{name}.json"),
    ]
    .iter()
    .collect();
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// Same isolation as the TS test: no system/user config, C locale, UTC.
fn runner(repo: &Repo) -> GitRunner {
    GitRunner::default().with_base_env(vec![
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("HOME".into(), repo.path().to_string_lossy().into_owned()),
        ("LC_ALL".into(), "C".into()),
        ("TZ".into(), "UTC".into()),
    ])
}

fn head(repo: &Repo) -> String {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo.path())
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn same<T: serde::Serialize>(name: &str, actual: T) {
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        fixture(name),
        "{name} differs from fixtures/git-contract/{name}.json"
    );
}

#[tokio::test]
async fn status_matches_golden_fixture() {
    let repo = build_repo();
    same(
        "status",
        git::status(&runner(&repo), repo.path()).await.unwrap(),
    );
}

#[tokio::test]
async fn log_matches_golden_fixture() {
    let repo = build_repo();
    same(
        "log",
        git::log(&runner(&repo), repo.path(), 400, 0).await.unwrap(),
    );
}

#[tokio::test]
async fn refs_matches_golden_fixture() {
    let repo = build_repo();
    same(
        "refs",
        git::refs(&runner(&repo), repo.path()).await.unwrap(),
    );
}

#[tokio::test]
async fn reflog_matches_golden_fixture() {
    let repo = build_repo();
    same(
        "reflog",
        git::reflog(&runner(&repo), repo.path()).await.unwrap(),
    );
}

#[tokio::test]
async fn commit_detail_matches_golden_fixture() {
    let repo = build_repo();
    same(
        "commitDetail",
        git::commit_detail(&runner(&repo), repo.path(), &head(&repo))
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn file_change_counts_match_golden_fixture() {
    let repo = build_repo();
    same(
        "fileChangeCounts",
        git::file_change_counts(&runner(&repo), repo.path())
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn blame_and_history_match_golden_fixtures() {
    let repo = build_repo();
    let (git, h) = (runner(&repo), head(&repo));
    same(
        "fileBlame",
        git::file_blame(&git, repo.path(), &h, "app.txt")
            .await
            .unwrap(),
    );
    same(
        "fileHistory",
        git::file_history(&git, repo.path(), &h, "app.txt")
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn op_state_and_history_position_match_golden_fixtures() {
    let repo = build_repo();
    let (git, h) = (runner(&repo), head(&repo));
    same("opState", git::op_state(&git, repo.path()).await.unwrap());
    same(
        "historyPosition",
        git::history_position(&git, repo.path(), &h).await.unwrap(),
    );
}

#[tokio::test]
async fn diffs_match_golden_fixtures() {
    let repo = build_repo();
    let (git, h, p) = (runner(&repo), head(&repo), repo.path());
    same(
        "commitFileDiff",
        git::commit_file_diff(&git, p, &h, "login.txt", None)
            .await
            .unwrap(),
    );
    let diff = |file: &'static str, area| {
        let git = git.clone();
        async move { git::working_file_diff(&git, p, file, area).await.unwrap() }
    };
    same(
        "workingFileDiff",
        serde_json::json!({
            "staged": diff("login.txt", git::Area::Staged).await,
            "unstaged": diff("app.txt", git::Area::Unstaged).await,
            "deleted": diff("README.md", git::Area::Unstaged).await,
            "untracked": diff("notes.md", git::Area::Untracked).await,
        }),
    );
}

#[tokio::test]
async fn failing_git_reports_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let err = GitRunner::default()
        .run(dir.path(), &["status"], Default::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "git");
    assert!(
        err.to_string()
            .to_lowercase()
            .contains("not a git repository"),
        "{err}"
    );
}
