//! `pushInfo` and `pushBranch` (system, SSH key or HTTPS token auth).
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::log::is_object_id;
use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushInfo {
    pub branch: String,
    pub remotes: Vec<String>,
    pub remote: String,
    pub target: String,
    pub remote_hash: Option<String>,
}

async fn config_get(git: &GitRunner, cwd: &Path, key: &str) -> String {
    git.run(cwd, &["config", "--get", key], RunOpts::default())
        .await
        .unwrap_or_default()
        .trim()
        .to_owned()
}

pub async fn push_info(git: &GitRunner, cwd: &Path) -> Result<PushInfo> {
    let branch = git
        .run(cwd, &["branch", "--show-current"], RunOpts::default())
        .await?
        .trim()
        .to_owned();
    let remotes: Vec<String> = git
        .run(cwd, &["remote"], RunOpts::default())
        .await?
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    let (remote, merge) = if branch.is_empty() {
        (String::new(), String::new())
    } else {
        (
            config_get(git, cwd, &format!("branch.{branch}.remote")).await,
            config_get(git, cwd, &format!("branch.{branch}.merge")).await,
        )
    };
    let selected = if !remote.is_empty() {
        remote
    } else if remotes.iter().any(|r| r == "origin") {
        "origin".to_owned()
    } else {
        remotes.first().cloned().unwrap_or_default()
    };
    let target = merge
        .strip_prefix("refs/heads/")
        .map(str::to_owned)
        .unwrap_or_else(|| branch.clone());
    let remote_hash = if !selected.is_empty() && !target.is_empty() {
        let r = format!("refs/remotes/{selected}/{target}");
        let h = git
            .run(cwd, &["rev-parse", "--verify", &r], RunOpts::default())
            .await
            .unwrap_or_default();
        Some(h.trim().to_owned()).filter(|h| !h.is_empty())
    } else {
        None
    };
    Ok(PushInfo {
        branch,
        remotes,
        remote: selected,
        target,
        remote_hash,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    #[default]
    System,
    Ssh,
    Https,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushAuth {
    #[serde(default)]
    pub kind: AuthKind,
    pub username: Option<String>,
    pub ssh_key: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOptions {
    #[serde(default)]
    pub force_with_lease: bool,
    pub expected_remote_hash: Option<String>,
}

fn invalid(m: &str) -> AppError {
    AppError::Invalid(m.to_owned())
}

pub async fn push_branch(
    git: &GitRunner,
    cwd: &Path,
    remote: &str,
    branch: &str,
    target: &str,
    auth: Option<&PushAuth>,
    options: Option<&PushOptions>,
) -> Result<String> {
    let info = push_info(git, cwd).await?;
    if branch.is_empty() || info.branch != branch {
        return Err(invalid(
            "The current branch changed. Reopen the push dialog.",
        ));
    }
    if !info.remotes.iter().any(|r| r == remote) {
        return Err(invalid("The selected remote no longer exists."));
    }
    git.run(
        cwd,
        &["check-ref-format", "--branch", target],
        RunOpts::default(),
    )
    .await?;
    let mut opts = RunOpts::default().env("GIT_TERMINAL_PROMPT", "0");
    let mut args: Vec<String> = vec!["push".into(), "--set-upstream".into()];
    if let Some(o) = options.filter(|o| o.force_with_lease) {
        let hash = o.expected_remote_hash.as_deref().filter(|h| {
            (h.len() == 40 || h.len() == 64)
                && is_object_id(h)
                && h.bytes().all(|b| !b.is_ascii_uppercase())
        });
        let Some(hash) = hash else {
            return Err(invalid(
                "Fetch the remote branch and reopen the push dialog before force pushing.",
            ));
        };
        args.push(format!("--force-with-lease=refs/heads/{target}:{hash}"));
    }
    args.extend([
        "--".into(),
        remote.into(),
        format!("refs/heads/{branch}:refs/heads/{target}"),
    ]);

    let mut _askpass_dir = None;
    match auth.map(|a| a.kind).unwrap_or_default() {
        AuthKind::System => {}
        AuthKind::Ssh => {
            let key = auth.and_then(|a| a.ssh_key.as_deref()).unwrap_or_default();
            if key.is_empty() || key.contains(['\r', '\n', '\0']) {
                return Err(invalid("Choose a valid SSH private key."));
            }
            let url = git
                .run(
                    cwd,
                    &["remote", "get-url", "--push", remote],
                    RunOpts::default(),
                )
                .await?
                .trim()
                .to_lowercase();
            let scp = url.split_once('@').is_some_and(|(user, rest)| {
                !user.is_empty()
                    && !user.contains(['/', ':'])
                    && rest
                        .split_once(':')
                        .is_some_and(|(host, _)| !host.is_empty() && !host.contains('/'))
            });
            if !(url.starts_with("ssh://") || scp) {
                return Err(invalid("This profile needs an SSH remote URL."));
            }
            let quoted = key.replace('\'', "'\\''");
            opts = opts.env(
                "GIT_SSH_COMMAND",
                &format!("ssh -o BatchMode=yes -o IdentitiesOnly=yes -i '{quoted}'"),
            );
        }
        AuthKind::Https => {
            let url = git
                .run(
                    cwd,
                    &["remote", "get-url", "--push", remote],
                    RunOpts::default(),
                )
                .await?
                .trim()
                .to_lowercase();
            if !url.starts_with("https://") {
                return Err(invalid("This profile needs an HTTPS remote URL."));
            }
            let (user, token) = auth
                .map(|a| (a.username.clone(), a.token.clone()))
                .unwrap_or_default();
            let (Some(user), Some(token)) = (
                user.filter(|u| !u.is_empty()),
                token.filter(|t| !t.is_empty()),
            ) else {
                return Err(invalid("Save a username and token for this profile."));
            };
            if cfg!(windows) {
                return Err(invalid(
                    "HTTPS token profiles are not yet available on Windows. Use the system credential manager.",
                ));
            }
            // A private askpass script answers git's prompts from env vars, so the token never
            // appears in argv or in the remote URL.
            let dir = tempfile::Builder::new()
                .prefix("gitverse-auth-")
                .tempdir()?;
            let askpass = dir.path().join("askpass");
            std::fs::write(
                &askpass,
                "#!/bin/sh\ncase \"$1\" in *sername*) printf \"%s\\n\" \"$GITVERSE_PUSH_USER\" ;; *) printf \"%s\\n\" \"$GITVERSE_PUSH_TOKEN\" ;; esac\n",
            )?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o700))?;
            }
            opts = opts
                .env("GIT_ASKPASS", &askpass.to_string_lossy())
                .env("GITVERSE_PUSH_USER", &user)
                .env("GITVERSE_PUSH_TOKEN", &token);
            args.splice(0..0, ["-c".to_owned(), "credential.helper=".to_owned()]);
            _askpass_dir = Some(dir);
        }
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    git.run(cwd, &args, opts).await
}
