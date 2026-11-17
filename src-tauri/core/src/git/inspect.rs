//! Port of electron/git/workspaceInspection.ts: worktrees and remotes for the inspection panel.
use std::path::Path;

use serde::Serialize;

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

/// Never send URL credentials, query strings or fragments to the UI.
pub fn display_url(value: &str) -> String {
    let cleaned = value.replace(['\r', '\n'], " ");
    if let Ok(mut parsed) = url::Url::parse(&cleaned) {
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
        parsed.set_query(None);
        parsed.set_fragment(None);
        return parsed.to_string();
    }
    // scheme://user@host/...  →  scheme://host/...
    let mut s = cleaned;
    if let Some(i) = s.find("://") {
        let scheme_ok = s[..i]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && s[..i]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
        if scheme_ok {
            let rest = &s[i + 3..];
            let authority_end = rest.find('/').unwrap_or(rest.len());
            if let Some(at) = rest[..authority_end].rfind('@') {
                s = format!("{}{}", &s[..i + 3], &rest[at + 1..]);
            }
        }
    }
    // user@host:path (scp style)  →  host:path
    if let Some(at) = s.find('@') {
        let user_ok = at > 0 && !s[..at].contains(['/', ':']);
        let host_ok = s[at + 1..]
            .split_once(':')
            .is_some_and(|(h, _)| !h.is_empty() && !h.contains('/'));
        if user_ok && host_ok {
            s = s[at + 1..].to_owned();
        }
    }
    if let Some(i) = s.find(['?', '#']) {
        s.truncate(i);
    }
    s
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteUrls {
    pub name: String,
    pub fetch: Vec<String>,
    pub push: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Worktree {
    pub path: String,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workspace {
    pub remotes: Vec<RemoteUrls>,
    pub worktrees: Vec<Worktree>,
}

pub async fn inspect_workspace(git: &GitRunner, cwd: &Path) -> Result<Workspace> {
    let opts = || {
        RunOpts {
            no_identity: true,
            ..RunOpts::default()
        }
        .env("GIT_OPTIONAL_LOCKS", "0")
    };
    let worktree_out = git
        .run(cwd, &["worktree", "list", "--porcelain", "-z"], opts())
        .await?;
    // exit 1 = no matching remote settings
    let config = match git
        .run(
            cwd,
            &[
                "config",
                "--null",
                "--get-regexp",
                r"^remote\..*\.(url|pushurl)$",
            ],
            opts(),
        )
        .await
    {
        Ok(c) => c,
        Err(AppError::Git { code: Some(1), .. }) => String::new(),
        Err(e) => return Err(e),
    };
    let mut remotes: Vec<RemoteUrls> = Vec::new();
    for item in config.split('\0').filter(|i| !i.is_empty()) {
        let Some((key, value)) = item.split_once('\n') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("remote.") else {
            continue;
        };
        let lower = rest.to_lowercase();
        let (name, is_url) = if lower.ends_with(".url") {
            (&rest[..rest.len() - 4], true)
        } else if lower.ends_with(".pushurl") {
            (&rest[..rest.len() - 8], false)
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let idx = match remotes.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                remotes.push(RemoteUrls {
                    name: name.to_owned(),
                    fetch: vec![],
                    push: vec![],
                });
                remotes.len() - 1
            }
        };
        let list = if is_url {
            &mut remotes[idx].fetch
        } else {
            &mut remotes[idx].push
        };
        list.push(display_url(value));
    }
    let worktrees = worktree_out
        .split("\0\0")
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let fields: Vec<&str> = record.split('\0').filter(|f| !f.is_empty()).collect();
            let value = |name: &str| {
                fields
                    .iter()
                    .find_map(|f| f.strip_prefix(name).and_then(|r| r.strip_prefix(' ')))
            };
            let branch =
                value("branch").map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_owned());
            let has = |name: &str| {
                fields
                    .iter()
                    .any(|f| *f == name || f.starts_with(&format!("{name} ")))
            };
            let path = value("worktree").unwrap_or_default().to_owned();
            (!path.is_empty()).then(|| Worktree {
                path,
                head: value("HEAD").unwrap_or_default().to_owned(),
                branch,
                detached: fields.contains(&"detached"),
                bare: fields.contains(&"bare"),
                locked: has("locked"),
                prunable: has("prunable"),
            })
        })
        .collect();
    Ok(Workspace { remotes, worktrees })
}

#[cfg(test)]
mod tests {
    use super::display_url;

    #[test]
    fn strips_credentials_query_and_fragment() {
        assert_eq!(
            display_url("https://user:secret@example.com/team/repo.git?token=abc#frag"),
            "https://example.com/team/repo.git"
        );
        assert_eq!(
            display_url("git@example.com:team/repo.git"),
            "example.com:team/repo.git"
        );
        assert_eq!(
            display_url("ssh://git@example.com/repo.git"),
            "ssh://example.com/repo.git"
        );
    }
}
