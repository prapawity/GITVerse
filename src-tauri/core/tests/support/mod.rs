//! Shared harness for the golden contract tests; mirrors electron/git/contractRepo.ts.
#![allow(dead_code)]
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::process::Command;

use gitverse_core::git::GitRunner;

pub struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
    clock: Cell<u64>,
}

/// Identity and fixed clock for commits made by the code under test (OPERATION_ENV in TS).
pub const OPERATION_ENV: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "Grace Hopper"),
    ("GIT_AUTHOR_EMAIL", "grace@example.com"),
    ("GIT_COMMITTER_NAME", "Grace Hopper"),
    ("GIT_COMMITTER_EMAIL", "grace@example.com"),
    ("GIT_AUTHOR_DATE", "1700100000 +0700"),
    ("GIT_COMMITTER_DATE", "1700100000 +0700"),
];

impl Repo {
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Raw git for setup, with an advancing clock (rawGit in TS). Panics on failure.
    pub fn git(&self, args: &[&str]) -> String {
        let out = self.git_output(args);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    /// Like `git` but tolerates failure (e.g. a merge that is expected to conflict).
    pub fn git_try(&self, args: &[&str]) {
        let _ = self.git_output(args);
    }

    fn git_output(&self, args: &[&str]) -> std::process::Output {
        self.clock.set(self.clock.get() + 60);
        let date = format!("{} +0700", self.clock.get());
        Command::new("git")
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
            .expect("git runs")
    }

    pub fn put(&self, file: &str, text: &str) {
        std::fs::write(self.path().join(file), text).unwrap();
    }

    pub fn root_str(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Runner isolated like the TS tests; `operation` adds the fixed identity/clock for new commits.
    pub fn runner(&self, operation: bool) -> GitRunner {
        let mut env = vec![
            ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
            ("HOME".to_owned(), self.root_str()),
            ("LC_ALL".to_owned(), "C".to_owned()),
            ("TZ".to_owned(), "UTC".to_owned()),
        ];
        if operation {
            env.extend(
                OPERATION_ENV
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string())),
            );
        }
        GitRunner::default().with_base_env(env)
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }
}

/// Like Node's realpath: resolve symlinks (macOS /var → /private/var) without Windows' \\?\ prefix.
fn real(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap();
    let s = c.to_string_lossy();
    s.strip_prefix(r"\\?\").map(PathBuf::from).unwrap_or(c)
}

/// Must stay identical to buildRepo() in electron/git/contractRepo.ts.
pub fn build_repo() -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let root = real(dir.path());
    let repo = Repo {
        _dir: dir,
        root,
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
    // TS ends with `git rev-parse HEAD` through the same clock; keep later setup commits in step
    repo.git(&["rev-parse", "HEAD"]);
    repo
}

pub fn fixture(name: &str) -> serde_json::Value {
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

/// Temp paths (either slash style) become <repo>, like normalize() in TS.
pub fn normalize(value: serde_json::Value, repo: &Repo) -> serde_json::Value {
    let root = repo.root_str();
    let mut text = serde_json::to_string(&value).unwrap();
    for form in [root.clone(), root.replace('\\', "/")] {
        // match the JSON-escaped form of the path too
        let escaped = serde_json::to_string(&form).unwrap();
        text = text.replace(&escaped[1..escaped.len() - 1], "<repo>");
    }
    serde_json::from_str(&text).unwrap()
}

pub fn same<T: serde::Serialize>(name: &str, actual: T) {
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        fixture(name),
        "{name} differs from fixtures/git-contract/{name}.json"
    );
}
