//! Rust side of electron/git/contract.golden.test.ts: rebuild the same deterministic repository
//! and require byte-for-byte the same JSON as fixtures/git-contract/*.json.
mod support;

use gitverse_core::git;
use support::{build_repo, same, Repo};

fn runner(repo: &Repo) -> git::GitRunner {
    repo.runner(false)
}

fn head(repo: &Repo) -> String {
    repo.head()
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
    let err = git::GitRunner::default()
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
