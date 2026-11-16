//! `refs` (branches, remotes, tags, stashes) from electron/git/git.ts.
use std::path::Path;

use serde::Serialize;

use super::log::{is_remote_head_alias, F, R};
use super::{GitRunner, RunOpts};
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub gone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteBranch {
    pub name: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tag {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRef {
    pub id: String,
    pub hash: String,
    pub base_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub body: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub local: Vec<LocalBranch>,
    pub remote: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
    pub stashes: Vec<StashRef>,
    pub head_hash: Option<String>,
}

fn track_count(track: &str, word: &str) -> u64 {
    // "[ahead 2, behind 1]"
    track
        .split(['[', ']', ','])
        .map(str::trim)
        .find_map(|part| part.strip_prefix(word)?.trim().parse().ok())
        .unwrap_or(0)
}

pub fn parse_for_each_ref(out: &str, head_hash: Option<String>) -> RefList {
    let mut res = RefList {
        local: vec![],
        remote: vec![],
        tags: vec![],
        stashes: vec![],
        head_hash,
    };
    for line in out.split('\n').filter(|l| !l.is_empty()) {
        let mut f = line.split('\t');
        let mut next = || f.next().unwrap_or_default();
        let (refname, head, hash, upstream, track) = (next(), next(), next(), next(), next());
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            res.local.push(LocalBranch {
                name: name.to_owned(),
                current: head == "*",
                hash: hash.to_owned(),
                upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
                ahead: track_count(track, "ahead "),
                behind: track_count(track, "behind "),
                gone: track.contains("gone"),
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if !is_remote_head_alias(name) {
                res.remote.push(RemoteBranch {
                    name: name.to_owned(),
                    hash: hash.to_owned(),
                });
            }
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            res.tags.push(Tag {
                name: name.to_owned(),
            });
        }
    }
    res
}

/// Strip git's "On main: " / "WIP on main: " prefix from a stash reflog subject.
fn stash_message(subject: &str) -> String {
    for prefix in ["On ", "WIP on "] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            // the branch part (`.+?`) needs at least one character
            if let Some(i) = rest.get(1..).and_then(|r| r.find(": ")) {
                return rest[i + 3..].to_owned();
            }
        }
    }
    subject.to_owned()
}

pub fn parse_stashes(out: &str) -> Vec<StashRef> {
    out.split(R)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|record| {
            let mut f = record.split(F);
            let mut next = || f.next().unwrap_or_default();
            let (id, hash, parents, author, email, date, subject, body) = (
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
            );
            StashRef {
                id: id.to_owned(),
                hash: hash.to_owned(),
                base_hash: parents.split(' ').next().unwrap_or_default().to_owned(),
                author: author.to_owned(),
                email: email.to_owned(),
                date: date.to_owned(),
                body: body.trim().to_owned(),
                message: stash_message(subject),
            }
        })
        .collect()
}

pub async fn refs(git: &GitRunner, cwd: &Path) -> Result<RefList> {
    let out = git
        .run(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname)%09%(HEAD)%09%(objectname)%09%(upstream:short)%09%(upstream:track)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ],
            RunOpts::default(),
        )
        .await?;
    let head = git
        .run(cwd, &["rev-parse", "--verify", "HEAD"], RunOpts::default())
        .await
        .unwrap_or_default();
    let head = head.trim();
    let mut res = parse_for_each_ref(&out, (!head.is_empty()).then(|| head.to_owned()));
    res.stashes = stash_entries(git, cwd).await?;
    Ok(res)
}

pub async fn stash_entries(git: &GitRunner, cwd: &Path) -> Result<Vec<StashRef>> {
    let format = "--format=%gd%x1f%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%gs%x1f%B%x1e";
    let out = git
        .run(cwd, &["stash", "list", format], RunOpts::default())
        .await?;
    Ok(parse_stashes(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tracking_and_hides_remote_head() {
        let out = "refs/heads/main\t*\taaa\torigin/main\t[ahead 2, behind 3]\nrefs/heads/old\t \tbbb\torigin/old\t[gone]\nrefs/remotes/origin/HEAD\t \taaa\t\t\nrefs/remotes/origin/main\t \taaa\t\t\nrefs/tags/v1\t \tccc\t\t\n";
        let r = parse_for_each_ref(out, Some("aaa".into()));
        assert_eq!(
            (r.local[0].ahead, r.local[0].behind, r.local[0].current),
            (2, 3, true)
        );
        assert_eq!(r.local[0].upstream.as_deref(), Some("origin/main"));
        assert!(r.local[1].gone);
        assert_eq!(r.remote.len(), 1);
        assert_eq!(r.tags[0].name, "v1");
    }

    #[test]
    fn strips_stash_prefixes() {
        assert_eq!(stash_message("On main: wip on app"), "wip on app");
        assert_eq!(stash_message("WIP on feature/x: abc123 msg"), "abc123 msg");
        assert_eq!(stash_message("custom"), "custom");
    }
}
