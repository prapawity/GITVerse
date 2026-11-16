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

// ---- phase 3 batch B ----

/// A bare `origin` next to the repo, with main and feature/login pushed and tracked.
fn with_origin(r: &Repo) -> String {
    clean(r);
    let origin = format!("{}-origin.git", r.root_str());
    r.git(&["init", "--quiet", "--bare", &origin]);
    r.git(&["remote", "add", "origin", &origin]);
    r.git(&["push", "--quiet", "-u", "origin", "main", "feature/login"]);
    origin
}

fn two_commits(r: &Repo) {
    r.put("one.txt", "one\n");
    r.git(&["add", "one.txt"]);
    r.git(&["commit", "--quiet", "-m", "One"]);
    r.put("two.txt", "two\n");
    r.git(&["add", "two.txt"]);
    r.git(&["commit", "--quiet", "-m", "Two"]);
}

fn rev(p: &std::path::Path, refs: &[&str]) -> Vec<String> {
    refs.iter()
        .map(|r| {
            let out = std::process::Command::new("git")
                .args(["rev-parse", r])
                .current_dir(p)
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        })
        .collect()
}

/// Remove sibling folders a scenario may create next to the temp repo.
fn cleanup(r: &Repo) {
    for suffix in ["-origin.git", "-wt", "-clone"] {
        let _ = std::fs::remove_dir_all(format!("{}{suffix}", r.root_str()));
    }
}

macro_rules! scenario_b {
    ($name:ident, |$r:ident| $setup:block, |$g:ident, $p:ident, $h:ident| $run:expr) => {
        #[tokio::test]
        async fn $name() {
            let $r = build_repo();
            $setup;
            let $g = $r.runner(true);
            let $p = $r.path();
            let $h = git::IndexHistory::default();
            let _ = &$h;
            let outcome = $run;
            check(stringify!($name).trim_start_matches("b_"), &$r, outcome).await;
            cleanup(&$r);
        }
    };
    ($name:ident, |$g:ident, $p:ident, $h:ident| $run:expr) => {
        scenario_b!($name, |_r| {}, |$g, $p, $h| $run);
    };
}

use git::Area;

scenario_b!(b_stagedForCommitMessage, |g, p, _h| {
    git::staged_for_commit_message(&g, p).await
});
scenario_b!(
    b_stagedForCommitMessageEmpty,
    |r| { clean(&r) },
    |g, p, _h| git::staged_for_commit_message(&g, p).await
);
scenario_b!(
    b_checkoutRemoteCreatesTrackingBranch,
    |r| {
        with_origin(&r);
        r.git(&["branch", "-D", "feature/login"]);
    },
    |g, p, _h| git::checkout_remote(&g, p, "origin/feature/login", false, None).await
);
scenario_b!(
    b_checkoutRemoteFastForwards,
    |r| {
        with_origin(&r);
        r.git(&["reset", "--quiet", "--hard", "HEAD~1"]);
    },
    |g, p, _h| git::checkout_remote(&g, p, "origin/main", false, None).await
);
scenario_b!(
    b_checkoutRemoteRejectsDiverged,
    |r| {
        with_origin(&r);
        r.git(&["reset", "--quiet", "--hard", "HEAD~1"]);
        r.put("local.txt", "local\n");
        r.git(&["add", "local.txt"]);
        r.git(&["commit", "--quiet", "-m", "Local only"]);
    },
    |g, p, _h| git::checkout_remote(&g, p, "origin/main", false, None).await
);
scenario_b!(b_checkoutRemoteRejectsInvalid, |g, p, _h| {
    git::checkout_remote(&g, p, "nope", false, None).await
});
scenario_b!(b_trackedStageUndoRedo, |g, p, h| async {
    let staged = h.tracked_stage(&g, p, true, &strings(&["app.txt"])).await?;
    let undone = h.move_history(&g, p, true).await?;
    let redone = h.move_history(&g, p, false).await?;
    let now = h.state(&g, p).await?;
    Ok::<_, AppError>(json!({ "staged": staged, "undone": undone, "redone": redone, "now": now }))
}
.await);
scenario_b!(b_moveIndexHistoryWithoutHistory, |g, p, h| h
    .move_history(&g, p, true)
    .await);
scenario_b!(b_stageWorkingHunk, |g, p, h| async {
    let diff = git::working_file_diff(&g, p, "app.txt", Area::Unstaged).await?;
    git::stage_working_hunk(&g, &h, p, "app.txt", Area::Unstaged, &diff, 0).await?;
    h.state(&g, p).await
}
.await);
scenario_b!(b_unstageWorkingHunk, |g, p, h| async {
    let diff = git::working_file_diff(&g, p, "login.txt", Area::Staged).await?;
    git::stage_working_hunk(&g, &h, p, "login.txt", Area::Staged, &diff, 0).await
}
.await);
scenario_b!(b_stageWorkingHunkRejectsStaleDiff, |g, p, h| {
    git::stage_working_hunk(&g, &h, p, "app.txt", Area::Unstaged, "old", 0).await
});
scenario_b!(b_stageWorkingHunkRejectsNewFile, |g, p, h| async {
    git::stage(&g, p, &strings(&["notes.md"])).await?;
    let diff = git::working_file_diff(&g, p, "notes.md", Area::Staged).await?;
    git::stage_working_hunk(&g, &h, p, "notes.md", Area::Staged, &diff, 0).await
}
.await);
scenario_b!(b_discardWorkingHunk, |g, p, _h| async {
    let diff = git::working_file_diff(&g, p, "app.txt", Area::Unstaged).await?;
    git::discard_working_hunk(&g, p, "app.txt", &diff, 0).await
}
.await);
scenario_b!(b_discardWorkingFiles, |g, p, _h| async {
    let files = vec![
        git::DiscardFile {
            path: "app.txt".into(),
            area: Area::Unstaged,
            diff: git::working_file_diff(&g, p, "app.txt", Area::Unstaged).await?,
        },
        git::DiscardFile {
            path: "notes.md".into(),
            area: Area::Untracked,
            diff: git::working_file_diff(&g, p, "notes.md", Area::Untracked).await?,
        },
    ];
    git::discard_working_files(&g, p, &files).await
}
.await);
scenario_b!(b_discardWorkingFilesRejectsStaleDiff, |g, p, _h| {
    git::discard_working_files(
        &g,
        p,
        &[git::DiscardFile {
            path: "app.txt".into(),
            area: Area::Unstaged,
            diff: "old".into(),
        }],
    )
    .await
});
scenario_b!(
    b_squashCommits,
    |r| {
        clean(&r);
        two_commits(&r);
    },
    |g, p, _h| git::squash_commits(&g, p, &rev(p, &["HEAD", "HEAD~1"]), "One and two").await
);
scenario_b!(b_squashRejectsDirtyTree, |g, p, _h| git::squash_commits(
    &g,
    p,
    &rev(p, &["HEAD^2", "HEAD^1"]),
    "Nope"
)
.await);
scenario_b!(b_squashRejectsMergeCommit, |r| { clean(&r) }, |g, p, _h| {
    git::squash_commits(&g, p, &rev(p, &["HEAD", "HEAD~1"]), "Nope").await
});
scenario_b!(
    b_cherryPickMany,
    |r| {
        clean(&r);
        r.git(&["checkout", "--quiet", "-b", "pick", "v1.0.0"]);
    },
    |g, p, _h| git::cherry_pick_many(&g, p, &rev(p, &["feature/login", "main~1"])).await
);
scenario_b!(
    b_cherryPickManyRejectsMerge,
    |r| { clean(&r) },
    |g, p, _h| git::cherry_pick_many(&g, p, &rev(p, &["main", "main~1"])).await
);
scenario_b!(b_stashFileDiff, |g, p, _h| git::stash_file_diff(
    &g,
    p,
    "stash@{0}",
    "app.txt"
)
.await);
scenario_b!(b_stashFileAt, |g, p, _h| git::stash_file_at(
    &g,
    p,
    "stash@{0}",
    "app.txt"
)
.await);
scenario_b!(
    b_stashUntrackedFileDiff,
    |r| {
        r.git(&[
            "stash",
            "push",
            "--quiet",
            "--include-untracked",
            "-m",
            "with untracked",
        ]);
    },
    |g, p, _h| async {
        Ok::<_, AppError>(json!({
            "diff": git::stash_file_diff(&g, p, "stash@{0}", "notes.md").await?,
            "content": git::stash_file_at(&g, p, "stash@{0}", "notes.md").await?,
        }))
    }
    .await
);
scenario_b!(
    b_rebasePreview,
    |r| {
        with_origin(&r);
        two_commits(&r);
    },
    |g, p, _h| git::rebase_preview(&g, p, &rev(p, &["origin/main"])[0]).await
);
scenario_b!(
    b_rebasePreviewRequiresUpstream,
    |r| { clean(&r) },
    |g, p, _h| git::rebase_preview(&g, p, &rev(p, &["HEAD~1"])[0]).await
);
scenario_b!(b_fileBlobAt, |g, p, _h| git::file_blob_at(
    &g, p, "v1.0.0", "app.txt"
)
.await);
scenario_b!(b_workingFileBlob, |_g, p, _h| git::working_file_blob(
    p, "app.txt"
));
scenario_b!(b_workingFileBlobRejectsEscape, |_g, p, _h| {
    git::working_file_blob(p, "../outside.txt")
});
scenario_b!(b_worktreeAdd, |r| { clean(&r) }, |g, p, _h| async {
    let wt = format!("{}-wt", p.display());
    git::worktree_add(&g, p, &wt, "v1.0.0").await?;
    git::inspect_workspace(&g, p).await
}
.await);
scenario_b!(
    b_inspectWorkspaceRedactsCredentials,
    |r| {
        r.git(&[
            "remote",
            "add",
            "origin",
            "https://user:secret@example.com/team/repo.git?token=abc#frag",
        ]);
        r.git(&[
            "remote",
            "set-url",
            "--push",
            "origin",
            "git@example.com:team/repo.git",
        ]);
    },
    |g, p, _h| git::inspect_workspace(&g, p).await
);
scenario_b!(
    b_agentCheckpoints,
    |r| {
        r.git(&["update-ref", "refs/agents/session-1/checkpoint", "v1.0.0"]);
        r.git(&["update-ref", "refs/agents/session-2/checkpoint", "HEAD"]);
    },
    |g, p, _h| git::agent_checkpoints(&g, p).await
);
scenario_b!(
    b_pushInfo,
    |r| {
        with_origin(&r);
    },
    |g, p, _h| git::push_info(&g, p).await
);
scenario_b!(b_pushInfoWithoutRemote, |g, p, _h| git::push_info(&g, p)
    .await);
scenario_b!(
    b_pushBranchToNewTarget,
    |r| {
        with_origin(&r);
    },
    |g, p, _h| async {
        let auth = git::PushAuth::default();
        git::push_branch(&g, p, "origin", "main", "release", Some(&auth), None).await?;
        git::push_info(&g, p).await
    }
    .await
);
scenario_b!(
    b_pushBranchRejectsWrongBranch,
    |r| {
        with_origin(&r);
    },
    |g, p, _h| git::push_branch(&g, p, "origin", "other", "other", None, None).await
);
scenario_b!(
    b_pushBranchForceNeedsHash,
    |r| {
        with_origin(&r);
    },
    |g, p, _h| {
        let opts = git::PushOptions {
            force_with_lease: true,
            expected_remote_hash: None,
        };
        git::push_branch(&g, p, "origin", "main", "main", None, Some(&opts)).await
    }
);
scenario_b!(b_cloneRejectsLocalPath, |_g, p, _h| git::clone(
    &format!("{}-origin.git", p.display()),
    &format!("{}-clone", p.display()),
    |_| {}
)
.await);
scenario_b!(b_cloneRejectsEmbeddedCredentials, |_g, p, _h| git::clone(
    "https://user:pw@example.com/repo.git",
    &format!("{}-clone", p.display()),
    |_| {}
)
.await);
scenario_b!(b_cloneRejectsWindowsDrivePath, |_g, p, _h| git::clone(
    "C:\\repos\\project.git",
    &format!("{}-clone", p.display()),
    |_| {}
)
.await);
scenario_b!(b_cloneRejectsRelativeDestination, |_g, _p, _h| git::clone(
    "https://example.com/repo.git",
    "relative/dir",
    |_| {}
)
.await);
