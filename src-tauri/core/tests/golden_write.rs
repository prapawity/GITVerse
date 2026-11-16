//! Rust side of electron/git/contract.write.test.ts: replay each write scenario on the same
#![allow(non_snake_case)]
//! deterministic repository and require identical `{ result | error, after }` JSON.
mod support;

use gitverse_core::git::{self, CommitOpts, OpKind, PullMode, ResetMode, Side, StashOp};
use gitverse_core::AppError;
use serde_json::{json, Value};
use support::{build_repo, fixture, normalize, Repo};

/// Repository state after the operation (snapshot() in TS).
async fn snapshot(repo: &Repo) -> Value {
    let g = repo.runner(false);
    let p = repo.path();
    let log: Vec<Value> = git::log(&g, p, 400, 0)
        .await
        .unwrap()
        .into_iter()
        .map(|c| json!({ "hash": c.hash, "parents": c.parents, "subject": c.subject }))
        .collect();
    json!({
        "status": git::status(&g, p).await.unwrap(),
        "refs": git::refs(&g, p).await.unwrap(),
        "log": log,
        "operation": git::op_state(&g, p).await.unwrap(),
    })
}

async fn check<T: serde::Serialize>(name: &str, repo: &Repo, outcome: Result<T, AppError>) {
    let mut record = match outcome {
        Ok(value) => json!({ "result": serde_json::to_value(value).unwrap() }),
        Err(error) => json!({ "error": error.to_string() }),
    };
    record["after"] = snapshot(repo).await;
    let actual = normalize(record, repo);
    let expected = fixture(&format!("write/{name}"));
    let mut diffs = Vec::new();
    diff("", &actual, &expected, &mut diffs);
    assert!(
        diffs.is_empty(),
        "write/{name} differs from the TS fixture:\n{}",
        diffs.join("\n")
    );
}

/// Paths where two JSON values differ, for readable failures.
fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                diff(
                    &format!("{path}.{k}"),
                    x.get(k).unwrap_or(&Value::Null),
                    y.get(k).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, out);
            }
        }
        _ if a != b => out.push(format!("  {path}\n    rust: {a}\n    ts:   {b}")),
        _ => {}
    }
}

// ---- setup helpers (contract.write.test.ts) ----

fn clean(r: &Repo) {
    r.git(&["reset", "--quiet", "--hard", "HEAD"]);
    r.git(&["clean", "-fdq"]);
}

/// `main` and `clash` both edit README.md, then merge clash (conflicts).
fn conflict(r: &Repo) {
    clean(r);
    r.git(&["checkout", "--quiet", "-b", "clash"]);
    r.put("README.md", "# Demo\n\nfrom clash\n");
    r.git(&["commit", "--quiet", "-am", "Clash edit"]);
    r.git(&["checkout", "--quiet", "main"]);
    r.put("README.md", "# Demo\n\nfrom main\n");
    r.git(&["commit", "--quiet", "-am", "Main edit"]);
    r.git_try(&["merge", "--quiet", "clash"]);
}

fn loose_branch(r: &Repo) {
    clean(r);
    r.git(&["checkout", "--quiet", "-b", "loose"]);
    r.put("loose.txt", "loose\n");
    r.git(&["add", "loose.txt"]);
    r.git(&["commit", "--quiet", "-m", "Loose"]);
    r.git(&["checkout", "--quiet", "main"]);
}

/// format-patch ends with "-- \n<git version>"; drop it so fixtures do not depend on the git version.
fn without_git_version(patch: &str) -> String {
    match patch.rfind("\n-- \n") {
        Some(i) => patch[..i + 1].to_owned(),
        None => patch.to_owned(),
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// Run one scenario: build the repo, `setup` with raw git, `run` the operation under test.
macro_rules! scenario {
    ($name:ident, |$r:ident| $setup:block, |$g:ident, $p:ident| $run:expr) => {
        #[tokio::test]
        async fn $name() {
            let $r = build_repo();
            $setup;
            let $g = $r.runner(true);
            let $p = $r.path();
            let outcome = $run;
            check(stringify!($name).trim_start_matches("s_"), &$r, outcome).await;
        }
    };
    ($name:ident, |$g:ident, $p:ident| $run:expr) => {
        scenario!($name, |_r| {}, |$g, $p| $run);
    };
}

scenario!(s_stage, |g, p| git::stage(
    &g,
    p,
    &strings(&["app.txt", "notes.md", "README.md"])
)
.await);
scenario!(s_stageRejectsUnknownFile, |g, p| git::stage(
    &g,
    p,
    &strings(&["missing.txt"])
)
.await);
scenario!(s_unstage, |g, p| git::unstage(
    &g,
    p,
    &strings(&["login.txt"])
)
.await);
scenario!(s_commit, |g, p| git::commit(
    &g,
    p,
    "Remember me",
    "Adds the remember-me line.",
    CommitOpts::default()
)
.await);
scenario!(s_commitAmendKeepsMessage, |g, p| git::commit(
    &g,
    p,
    "",
    "",
    CommitOpts {
        amend: true,
        ..Default::default()
    }
)
.await);
scenario!(s_commitSignoff, |g, p| git::commit(
    &g,
    p,
    "Signed",
    "",
    CommitOpts {
        signoff: true,
        ..Default::default()
    }
)
.await);
scenario!(s_createBranch, |g, p| git::create_branch(
    &g, p, "topic", None
)
.await);
scenario!(s_createBranchFromTag, |r| { clean(&r) }, |g, p| {
    git::create_branch(&g, p, "from-tag", Some("v1.0.0")).await
});
scenario!(s_checkout, |r| { clean(&r) }, |g, p| git::checkout(
    &g,
    p,
    "feature/login"
)
.await);
scenario!(
    s_checkoutRejectsDirtyConflict,
    |r| {
        clean(&r);
        r.put("login.txt", "local edit\n");
    },
    |g, p| git::checkout(&g, p, "v1.0.0").await
);
scenario!(s_stash, |g, p| git::stash(&g, p, Some("park it")).await);
scenario!(s_stashPop, |r| { clean(&r) }, |g, p| git::stash_pop(&g, p)
    .await);
scenario!(s_stashApplyByHash, |r| { clean(&r) }, |g, p| {
    let hash = git::refs(&g, p).await.unwrap().stashes[0].hash.clone();
    git::stash_action(&g, p, &hash, StashOp::Apply).await
});
scenario!(s_stashDropByHash, |g, p| {
    let hash = git::refs(&g, p).await.unwrap().stashes[0].hash.clone();
    git::stash_action(&g, p, &hash, StashOp::Drop).await
});
scenario!(s_stashRejectsBadHash, |g, p| git::stash_action(
    &g,
    p,
    "not-a-hash",
    StashOp::Drop
)
.await);
scenario!(s_stashRename, |g, p| git::stash_rename(
    &g,
    p,
    "stash@{0}",
    "renamed stash"
)
.await);
scenario!(
    s_stashRenameOlder,
    |r| {
        r.git(&[
            "stash",
            "push",
            "--quiet",
            "--include-untracked",
            "-m",
            "newer",
        ]);
    },
    |g, p| git::stash_rename(&g, p, "stash@{1}", "renamed older").await
);
scenario!(
    s_stashRenameNewestOfTwo,
    |r| {
        r.git(&[
            "stash",
            "push",
            "--quiet",
            "--include-untracked",
            "-m",
            "newer",
        ]);
    },
    |g, p| git::stash_rename(&g, p, "stash@{0}", "renamed newer").await
);
scenario!(s_stashDetail, |g, p| git::stash_detail(&g, p, "stash@{0}")
    .await);
scenario!(s_stashDiff, |g, p| git::stash_diff(&g, p, "stash@{0}")
    .await);
scenario!(s_resetSoft, |g, p| git::reset(
    &g,
    p,
    "HEAD~1",
    ResetMode::Soft
)
.await);
scenario!(s_resetMixed, |g, p| git::reset(
    &g,
    p,
    "HEAD~1",
    ResetMode::Mixed
)
.await);
scenario!(s_resetHard, |g, p| git::reset(
    &g,
    p,
    "v1.0.0",
    ResetMode::Hard
)
.await);
scenario!(
    s_cherryPick,
    |r| {
        clean(&r);
        r.git(&["checkout", "--quiet", "-b", "pick", "v1.0.0"]);
    },
    |g, p| {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "main~1"])
            .current_dir(p)
            .output()
            .unwrap();
        let hash = String::from_utf8(out.stdout).unwrap().trim().to_owned();
        git::cherry_pick(&g, p, &hash).await
    }
);
scenario!(s_revert, |r| { clean(&r) }, |g, p| git::revert(
    &g, p, "HEAD^2"
)
.await);
scenario!(
    s_rebaseOnto,
    |r| {
        clean(&r);
        r.git(&["checkout", "--quiet", "-b", "topic", "v1.0.0"]);
        r.put("topic.txt", "topic\n");
        r.git(&["add", "topic.txt"]);
        r.git(&["commit", "--quiet", "-m", "Topic work"]);
    },
    |g, p| git::rebase_onto(&g, p, "main").await
);
scenario!(
    s_mergeNoFf,
    |r| {
        clean(&r);
        r.git(&["checkout", "--quiet", "-b", "side"]);
        r.put("side.txt", "side\n");
        r.git(&["add", "side.txt"]);
        r.git(&["commit", "--quiet", "-m", "Side work"]);
        r.git(&["checkout", "--quiet", "main"]);
    },
    |g, p| git::merge(&g, p, "side", true, false).await
);
scenario!(
    s_mergeConflict,
    |r| {
        conflict(&r);
        r.git(&["merge", "--abort"]);
    },
    |g, p| git::merge(&g, p, "clash", true, false).await
);
scenario!(s_resolveOursThenContinue, |r| { conflict(&r) }, |g, p| {
    git::resolve_file(&g, p, "README.md", Side::Ours)
        .await
        .unwrap();
    git::op_continue(&g, p, OpKind::Merge, Some("Merge clash, keep main")).await
});
scenario!(s_resolveTheirs, |r| { conflict(&r) }, |g, p| {
    git::resolve_file(&g, p, "README.md", Side::Theirs).await
});
scenario!(s_opAbort, |r| { conflict(&r) }, |g, p| git::op_abort(
    &g,
    p,
    OpKind::Merge
)
.await);
scenario!(s_createTag, |g, p| git::create_tag(&g, p, "v2.0.0", "HEAD")
    .await);
scenario!(s_createAnnotatedTag, |g, p| git::create_annotated_tag(
    &g,
    p,
    "v2.0.1",
    "HEAD",
    "Second release"
)
.await);
scenario!(s_tagCommit, |g, p| git::tag_commit(&g, p, "v1.0.1").await);
scenario!(s_branchAt, |r| { clean(&r) }, |g, p| git::branch_at(
    &g, p, "at-tag", "v1.0.0"
)
.await);
scenario!(s_deleteMergedBranch, |g, p| git::delete_branch(
    &g,
    p,
    "feature/login",
    false
)
.await);
scenario!(s_deleteCurrentBranchFails, |g, p| git::delete_branch(
    &g, p, "main", false
)
.await);
scenario!(
    s_deleteUnmergedBranchFails,
    |r| { loose_branch(&r) },
    |g, p| git::delete_branch(&g, p, "loose", false).await
);
scenario!(s_forceDeleteBranch, |r| { loose_branch(&r) }, |g, p| {
    git::delete_branch(&g, p, "loose", true).await
});
scenario!(s_setCommitIdentity, |g, p| {
    git::set_commit_identity(&g, p, "Katherine Johnson", "katherine@example.com")
        .await
        .unwrap();
    git::commit_identity(&g, p).await
});
scenario!(s_setCommitIdentityRejectsBadEmail, |g, p| {
    git::set_commit_identity(&g, p, "Name", "not an email").await
});
scenario!(s_fileAt, |g, p| git::file_at(&g, p, "v1.0.0", "app.txt")
    .await);
scenario!(s_formatPatch, |g, p| git::format_patch(&g, p, "v1.0.0")
    .await
    .map(|patch| without_git_version(&patch)));
scenario!(s_readWorkFile, |_g, p| git::read_work_file(p, "app.txt"));
scenario!(s_writeWorkFile, |_g, p| git::write_work_file(
    p,
    "app.txt",
    "rewritten\n"
));
scenario!(s_readWorkFileRejectsEscape, |_g, p| git::read_work_file(
    p,
    "../outside.txt"
));
scenario!(s_remoteUrlMissing, |g, p| git::remote_url(&g, p).await);

#[tokio::test]
async fn pushPullFetchWithLocalRemote() {
    let r = build_repo();
    clean(&r);
    let origin = format!("{}-origin.git", r.root_str());
    r.git(&["init", "--quiet", "--bare", &origin]);
    r.git(&["remote", "add", "origin", &origin]);
    r.git(&["push", "--quiet", "-u", "origin", "main"]);
    let (g, p) = (r.runner(true), r.path());
    r.put("pushed.txt", "pushed\n");
    let outcome = async {
        git::stage(&g, p, &strings(&["pushed.txt"])).await?;
        git::commit(&g, p, "Pushed change", "", CommitOpts::default()).await?;
        git::push(&g, p).await?;
        git::fetch(&g, p, true).await?;
        git::pull(&g, p, PullMode::FfOnly).await?;
        git::remote_url(&g, p).await
    }
    .await;
    check("pushPullFetchWithLocalRemote", &r, outcome).await;
    let _ = std::fs::remove_dir_all(origin);
}
