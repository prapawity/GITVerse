//! `log` and `historyPosition` (electron/git/git.ts).
use std::path::Path;

use serde::Serialize;

use super::manage::HistoryScope;
use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

pub(crate) const F: char = '\x1f';
pub(crate) const R: char = '\x1e';

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Head,
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefLabel {
    pub name: String,
    pub kind: RefKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub refs: Vec<RefLabel>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    /// First non-empty line of the body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// `origin/HEAD` style aliases are hidden everywhere, like `isRemoteHeadAlias`.
pub(crate) fn is_remote_head_alias(name: &str) -> bool {
    name.strip_suffix("/HEAD")
        .is_some_and(|remote| !remote.is_empty() && !remote.contains('/'))
}

/// Parse `%D` with `--decorate=full`.
pub fn parse_refs(decoration: &str) -> Vec<RefLabel> {
    if decoration.trim().is_empty() {
        return Vec::new();
    }
    let label = |name: &str, kind, current| RefLabel {
        name: name.to_owned(),
        kind,
        current,
    };
    decoration
        .split(", ")
        .filter(|raw| {
            raw.strip_prefix("refs/remotes/")
                .is_none_or(|r| !is_remote_head_alias(r))
        })
        .map(|raw| {
            if let Some(n) = raw.strip_prefix("HEAD -> refs/heads/") {
                label(n, RefKind::Local, Some(true))
            } else if raw == "HEAD" {
                label("HEAD", RefKind::Head, Some(true))
            } else if let Some(n) = raw.strip_prefix("tag: refs/tags/") {
                label(n, RefKind::Tag, None)
            } else if let Some(n) = raw.strip_prefix("refs/heads/") {
                label(n, RefKind::Local, None)
            } else if let Some(n) = raw.strip_prefix("refs/remotes/") {
                label(n, RefKind::Remote, None)
            } else {
                label(raw, RefKind::Head, None)
            }
        })
        .collect()
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split(R)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|record| {
            let mut f = record.split(F);
            let mut next = || f.next().unwrap_or_default().to_owned();
            let (hash, parents, refs, author, email, date, subject, body) = (
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
                next(),
            );
            Commit {
                hash,
                parents: if parents.is_empty() {
                    Vec::new()
                } else {
                    parents.split(' ').map(str::to_owned).collect()
                },
                refs: parse_refs(&refs),
                author,
                email,
                date,
                subject,
                body: body
                    .split('\n')
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(str::to_owned),
            }
        })
        .collect()
}

fn history_order(sort: &str) -> Result<&'static str> {
    match sort {
        "topo" => Ok("--topo-order"),
        "date" => Ok("--date-order"),
        "author-date" => Ok("--author-date-order"),
        _ => Err(AppError::Invalid("Invalid history order.".into())),
    }
}

pub async fn log(git: &GitRunner, cwd: &Path, limit: u64, skip: u64) -> Result<Vec<Commit>> {
    log_sorted(git, cwd, limit, skip, "topo").await
}

pub async fn log_sorted(
    git: &GitRunner,
    cwd: &Path,
    limit: u64,
    skip: u64,
    sort: &str,
) -> Result<Vec<Commit>> {
    log_scoped(git, cwd, limit, skip, sort, &HistoryScope::default()).await
}

/// `log` in git.ts: history of every ref, minus hidden refs, or only the solo refs.
pub async fn log_scoped(
    git: &GitRunner,
    cwd: &Path,
    limit: u64,
    skip: u64,
    sort: &str,
    scope: &HistoryScope,
) -> Result<Vec<Commit>> {
    let revisions = scope.revisions()?;
    let solo = scope.is_solo();
    let order = history_order(sort)?;
    let stashes = super::refs::stash_entries(git, cwd).await?;
    let fmt = format!(
        "{}%x1e",
        ["%H", "%P", "%D", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f")
    );
    let has_head = git.succeeds(cwd, &["rev-parse", "--verify", "HEAD"]).await;
    let (skip, limit, fmt) = (
        format!("--skip={skip}"),
        format!("-n{limit}"),
        format!("--format={fmt}"),
    );
    let mut args = vec!["log"];
    args.extend(revisions.iter().map(String::as_str));
    args.extend([order, "--decorate=full", &skip, &limit, &fmt]);
    if has_head && !solo && !scope.head_hidden(git, cwd).await {
        args.push("HEAD");
    }
    if !solo && !scope.is_hiding() {
        args.extend(
            stashes
                .iter()
                .map(|stash| stash.base_hash.as_str())
                .filter(|hash| !hash.is_empty()),
        );
    }
    Ok(parse_log(&git.run(cwd, &args, RunOpts::default()).await?))
}

pub(crate) fn is_object_id(s: &str) -> bool {
    (40..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Index of `hash` in the same topo-ordered history the graph shows (for jumping to a commit).
pub async fn history_position(git: &GitRunner, cwd: &Path, hash: &str) -> Result<usize> {
    history_position_sorted(git, cwd, hash, "topo").await
}

pub async fn history_position_sorted(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    sort: &str,
) -> Result<usize> {
    history_position_scoped(git, cwd, hash, sort, &HistoryScope::default()).await
}

pub async fn history_position_scoped(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    sort: &str,
    scope: &HistoryScope,
) -> Result<usize> {
    let revisions = scope.revisions()?;
    let solo = scope.is_solo();
    let order = history_order(sort)?;
    if !is_object_id(hash) {
        return Err(AppError::Invalid("Invalid commit ID.".into()));
    }
    let stashes = super::refs::stash_entries(git, cwd).await?;
    let has_head = git.succeeds(cwd, &["rev-parse", "--verify", "HEAD"]).await;
    let mut args = vec!["rev-list"];
    args.extend(revisions.iter().map(String::as_str));
    args.push(order);
    if has_head && !solo && !scope.head_hidden(git, cwd).await {
        args.push("HEAD");
    }
    if !solo && !scope.is_hiding() {
        args.extend(
            stashes
                .iter()
                .map(|stash| stash.base_hash.as_str())
                .filter(|hash| !hash.is_empty()),
        );
    }
    let out = git.run(cwd, &args, RunOpts::default()).await?;
    out.split('\n')
        .position(|line| line == hash)
        .ok_or_else(|| {
            AppError::Invalid(
                "This commit is no longer in the repository history. Refresh and try again.".into(),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_history_order() {
        assert_eq!(history_order("topo").unwrap(), "--topo-order");
        assert_eq!(history_order("date").unwrap(), "--date-order");
        assert_eq!(history_order("author-date").unwrap(), "--author-date-order");
        assert!(history_order("invalid").is_err());
    }

    #[test]
    fn parses_decorations() {
        let refs = parse_refs("HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/HEAD, refs/remotes/origin/main, refs/heads/dev");
        let names: Vec<_> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.clone(), r.current))
            .collect();
        assert_eq!(
            names,
            vec![
                ("main", RefKind::Local, Some(true)),
                ("v1", RefKind::Tag, None),
                ("origin/main", RefKind::Remote, None),
                ("dev", RefKind::Local, None),
            ]
        );
        assert_eq!(parse_refs("HEAD")[0].kind, RefKind::Head);
        assert!(parse_refs("  ").is_empty());
    }

    #[test]
    fn remote_head_alias_only_matches_one_level() {
        assert!(is_remote_head_alias("origin/HEAD"));
        assert!(!is_remote_head_alias("origin/feature/HEAD"));
        assert!(!is_remote_head_alias("/HEAD"));
    }

    #[test]
    fn root_commit_has_no_parents_and_body_is_first_line() {
        let commits =
            parse_log("abc\x1f\x1f\x1fA\x1fa@x\x1f2024\x1fSubj\x1f\n\n  first  \nsecond\n\x1e\n");
        assert!(commits[0].parents.is_empty());
        assert_eq!(commits[0].body.as_deref(), Some("first"));
    }
}
