//! Branch rename, tags, remotes, .gitignore, commit template and signing settings.
//! Mirrors the functions of the same names in electron/git/git.ts.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// Which refs the graph shows (`HistoryScope` in git.ts). `hide` names are short; `solo` names are full refs.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct HistoryScope {
    #[serde(default)]
    pub hide: Option<HiddenRefs>,
    #[serde(default)]
    pub solo: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HiddenRefs {
    #[serde(default)]
    pub branches: Vec<String>,
    #[serde(default)]
    pub remotes: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `REF_PART` in git.ts.
fn ref_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
}

fn check_refs(names: &[String], full: bool) -> Result<Vec<String>> {
    if names.len() > 500 {
        return Err(invalid("Too many refs in the history filter."));
    }
    names
        .iter()
        .map(|n| {
            if ref_ok(n) && (!full || n.starts_with("refs/")) {
                Ok(n.clone())
            } else {
                Err(invalid("Invalid ref in the history filter."))
            }
        })
        .collect()
}

impl HistoryScope {
    pub fn is_hiding(&self) -> bool {
        self.hide
            .as_ref()
            .is_some_and(|h| !h.branches.is_empty() || !h.remotes.is_empty() || !h.tags.is_empty())
    }

    /// HEAD would bring a hidden checked-out branch back into the graph, so leave it out then.
    pub async fn head_hidden(&self, git: &GitRunner, cwd: &Path) -> bool {
        let Some(hide) = self.hide.as_ref().filter(|h| !h.branches.is_empty()) else {
            return false;
        };
        let current = git
            .run(
                cwd,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
                RunOpts::default(),
            )
            .await
            .unwrap_or_default();
        let current = current.trim();
        !current.is_empty() && hide.branches.iter().any(|b| b == current)
    }

    pub fn is_solo(&self) -> bool {
        self.solo.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// Revision arguments for log / rev-list (`scopeRevisions` in git.ts).
    pub fn revisions(&self) -> Result<Vec<String>> {
        let solo = check_refs(self.solo.as_deref().unwrap_or_default(), true)?;
        if !solo.is_empty() {
            return Ok(solo);
        }
        let hide = self.hide.clone().unwrap_or_default();
        let mut args = Vec::new();
        for (names, flag) in [
            (&hide.branches, "--branches"),
            (&hide.remotes, "--remotes"),
            (&hide.tags, "--tags"),
        ] {
            args.extend(
                check_refs(names, false)?
                    .into_iter()
                    .map(|n| format!("--exclude={n}")),
            );
            args.push(flag.to_owned());
        }
        Ok(args)
    }
}

async fn check_branch_name(git: &GitRunner, cwd: &Path, name: &str) -> Result<()> {
    if name.trim().is_empty() || name.starts_with('-') {
        return Err(invalid("Enter a branch name."));
    }
    if !git
        .succeeds(cwd, &["check-ref-format", "--branch", name])
        .await
    {
        return Err(invalid(format!("\"{name}\" is not a valid branch name.")));
    }
    Ok(())
}

async fn check_remote(git: &GitRunner, cwd: &Path, remote: &str) -> Result<()> {
    let list = git.run(cwd, &["remote"], RunOpts::default()).await?;
    if remote.is_empty() || !list.lines().any(|r| r.trim() == remote) {
        return Err(invalid(format!("There is no remote named \"{remote}\".")));
    }
    Ok(())
}

async fn check_tag(git: &GitRunner, cwd: &Path, tag: &str) -> Result<()> {
    if tag.is_empty() || tag.starts_with('-') {
        return Err(invalid("Invalid tag name."));
    }
    let full = format!("refs/tags/{tag}");
    if !git
        .succeeds(cwd, &["rev-parse", "--verify", "--quiet", &full])
        .await
    {
        return Err(invalid(format!("Tag \"{tag}\" does not exist.")));
    }
    Ok(())
}

pub async fn rename_branch(git: &GitRunner, cwd: &Path, from: &str, to: &str) -> Result<String> {
    if from.is_empty() || from.starts_with('-') {
        return Err(invalid("Invalid branch."));
    }
    check_branch_name(git, cwd, to).await?;
    let full = format!("refs/heads/{from}");
    if !git
        .succeeds(cwd, &["rev-parse", "--verify", "--quiet", &full])
        .await
    {
        return Err(invalid(format!("Branch \"{from}\" does not exist.")));
    }
    git.run(cwd, &["branch", "-m", from, to], RunOpts::default())
        .await
}

/// Push one tag, or every tag when `tag` is None.
pub async fn push_tag(
    git: &GitRunner,
    cwd: &Path,
    remote: &str,
    tag: Option<&str>,
) -> Result<String> {
    check_remote(git, cwd, remote).await?;
    let Some(tag) = tag else {
        return git
            .run(cwd, &["push", remote, "--tags"], RunOpts::default())
            .await;
    };
    check_tag(git, cwd, tag).await?;
    let full = format!("refs/tags/{tag}");
    git.run(cwd, &["push", remote, &full], RunOpts::default())
        .await
}

pub async fn delete_tag(
    git: &GitRunner,
    cwd: &Path,
    tag: &str,
    remote: Option<&str>,
) -> Result<String> {
    check_tag(git, cwd, tag).await?;
    if let Some(remote) = remote.filter(|r| !r.is_empty()) {
        check_remote(git, cwd, remote).await?;
        let spec = format!(":refs/tags/{tag}");
        git.run(cwd, &["push", remote, &spec], RunOpts::default())
            .await?;
    }
    git.run(cwd, &["tag", "-d", tag], RunOpts::default()).await
}

pub async fn add_remote(git: &GitRunner, cwd: &Path, name: &str, url: &str) -> Result<String> {
    if name.is_empty() || name.starts_with('-') {
        return Err(invalid("Enter a remote name."));
    }
    let probe = format!("refs/remotes/{name}/x");
    if !git.succeeds(cwd, &["check-ref-format", &probe]).await {
        return Err(invalid(format!("\"{name}\" is not a valid remote name.")));
    }
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return Err(invalid("Enter a valid remote URL."));
    }
    git.run(cwd, &["remote", "add", name, url], RunOpts::default())
        .await
}

pub async fn remove_remote(git: &GitRunner, cwd: &Path, name: &str) -> Result<String> {
    check_remote(git, cwd, name).await?;
    git.run(cwd, &["remote", "remove", name], RunOpts::default())
        .await
}

async fn top_level(git: &GitRunner, cwd: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(
        git.run(cwd, &["rev-parse", "--show-toplevel"], RunOpts::default())
            .await?
            .trim(),
    ))
}

/// Append `pattern` to the root .gitignore; optionally stop tracking `untrack`.
pub async fn ignore_path(
    git: &GitRunner,
    cwd: &Path,
    pattern: &str,
    untrack: Option<&str>,
) -> Result<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.contains(['\r', '\n', '\0']) {
        return Err(invalid("Invalid ignore pattern."));
    }
    let file = top_level(git, cwd).await?.join(".gitignore");
    let current = tokio::fs::read_to_string(&file).await.unwrap_or_default();
    if !current.lines().any(|line| line == pattern) {
        let prefix = if !current.is_empty() && !current.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        tokio::fs::write(&file, format!("{current}{prefix}{pattern}\n")).await?;
    }
    if let Some(path) = untrack.filter(|p| !p.is_empty()) {
        if path.contains('\0') || path.starts_with('-') {
            return Err(invalid("Invalid path."));
        }
        git.run(
            cwd,
            &[
                "--literal-pathspecs",
                "rm",
                "-r",
                "--cached",
                "--ignore-unmatch",
                "--",
                path,
            ],
            RunOpts::default(),
        )
        .await?;
    }
    Ok(String::new())
}

/// The configured commit.template without comment lines, or None.
pub async fn commit_template(git: &GitRunner, cwd: &Path) -> Result<Option<String>> {
    let configured = git
        .run(
            cwd,
            &["config", "--path", "--get", "commit.template"],
            RunOpts::default(),
        )
        .await
        .unwrap_or_default();
    let configured = configured.trim();
    if configured.is_empty() {
        return Ok(None);
    }
    let path = Path::new(configured);
    let file = if path.is_absolute() {
        path.to_path_buf()
    } else {
        top_level(git, cwd).await?.join(path)
    };
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return Ok(None);
    };
    let text: String = text.chars().take(64 * 1024).collect();
    Ok(Some(
        text.lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned(),
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningConfig {
    pub format: String,
    pub key: String,
    pub commits: bool,
    pub tags: bool,
    #[serde(default)]
    pub scope: String,
}

pub async fn signing_config(git: &GitRunner, cwd: &Path) -> Result<SigningConfig> {
    let get = |args: Vec<&'static str>| async move {
        git.run(cwd, &args, RunOpts::default())
            .await
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let (format, key, commits, tags, local) = tokio::join!(
        get(vec!["config", "--get", "gpg.format"]),
        get(vec!["config", "--get", "user.signingkey"]),
        get(vec!["config", "--get", "commit.gpgsign"]),
        get(vec!["config", "--get", "tag.gpgsign"]),
        get(vec!["config", "--local", "--get", "commit.gpgsign"]),
    );
    let scope = if !local.is_empty() {
        "local"
    } else if !commits.is_empty() || !key.is_empty() {
        "global"
    } else {
        "none"
    };
    Ok(SigningConfig {
        format: if format == "ssh" || format == "x509" {
            format
        } else {
            "openpgp".into()
        },
        key,
        commits: commits == "true",
        tags: tags == "true",
        scope: scope.into(),
    })
}

pub async fn set_signing_config(
    git: &GitRunner,
    cwd: &Path,
    config: SigningConfig,
    scope: &str,
) -> Result<String> {
    if !matches!(config.format.as_str(), "openpgp" | "ssh" | "x509") {
        return Err(invalid("Unknown signing format."));
    }
    if config.key.contains(['\r', '\n', '\0']) || config.key.starts_with('-') {
        return Err(invalid("Invalid signing key."));
    }
    let where_ = match scope {
        "local" => "--local",
        "global" => "--global",
        _ => return Err(invalid("Invalid scope.")),
    };
    let put = |key: &'static str, value: Option<String>| async move {
        match value.filter(|v| !v.is_empty()) {
            Some(v) => git
                .run(cwd, &["config", where_, key, &v], RunOpts::default())
                .await
                .map(|_| ()),
            None => {
                let _ = git
                    .run(
                        cwd,
                        &["config", where_, "--unset-all", key],
                        RunOpts::default(),
                    )
                    .await;
                Ok(())
            }
        }
    };
    put(
        "gpg.format",
        (config.format != "openpgp").then(|| config.format.clone()),
    )
    .await?;
    put("user.signingkey", Some(config.key.trim().to_owned())).await?;
    put("commit.gpgsign", Some(config.commits.to_string())).await?;
    put("tag.gpgsign", Some(config.tags.to_string())).await?;
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_matches_the_typescript_revisions() {
        let all = HistoryScope::default().revisions().unwrap();
        assert_eq!(all, ["--branches", "--remotes", "--tags"]);
        let hidden = HistoryScope {
            hide: Some(HiddenRefs {
                branches: vec!["feature/x".into()],
                remotes: vec!["origin/old".into()],
                tags: vec![],
            }),
            solo: None,
        };
        assert_eq!(
            hidden.revisions().unwrap(),
            [
                "--exclude=feature/x",
                "--branches",
                "--exclude=origin/old",
                "--remotes",
                "--tags"
            ]
        );
        let solo = HistoryScope {
            hide: None,
            solo: Some(vec!["refs/heads/main".into()]),
        };
        assert!(solo.is_solo());
        assert_eq!(solo.revisions().unwrap(), ["refs/heads/main"]);
        for bad in ["-x", "a b", "a..b", "a*"] {
            let s = HistoryScope {
                hide: Some(HiddenRefs {
                    branches: vec![bad.into()],
                    ..Default::default()
                }),
                solo: None,
            };
            assert!(s.revisions().is_err(), "{bad}");
        }
        let not_full = HistoryScope {
            hide: None,
            solo: Some(vec!["main".into()]),
        };
        assert!(not_full.revisions().is_err());
    }
}
