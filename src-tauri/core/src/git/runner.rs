use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, Result};

/// Commit identity applied with `-c user.name/-c user.email`, like `activeIdentity` in git.ts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Default, Clone)]
pub struct RunOpts {
    pub env: Vec<(String, String)>,
    pub stdin: Option<String>,
    /// None = no timeout (long fetch/clone); interactive reads should set one.
    pub timeout: Option<Duration>,
    pub cancel: Option<CancellationToken>,
}

#[derive(Clone)]
pub struct GitRunner {
    bin: PathBuf,
    identity: Arc<RwLock<Option<Identity>>>,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self::new("git")
    }
}

impl GitRunner {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            identity: Arc::new(RwLock::new(None)),
        }
    }

    pub fn set_identity(&self, identity: Option<Identity>) {
        *self.identity.write().unwrap_or_else(|e| e.into_inner()) = identity;
    }

    /// Run git in `cwd` and return stdout as UTF-8 (lossy, like Node's default decoding).
    pub async fn run(&self, cwd: &Path, args: &[&str], opts: RunOpts) -> Result<String> {
        let mut cmd = Command::new(&self.bin);
        let identity = self
            .identity
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(id) = identity {
            cmd.arg("-c").arg(format!("user.name={}", id.name));
            cmd.arg("-c").arg(format!("user.email={}", id.email));
        }
        cmd.args(args)
            .current_dir(cwd)
            // never block on an interactive credential prompt the user cannot see
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(if opts.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: no console window flashing for every git call
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd.spawn().map_err(|e| AppError::Spawn(e.to_string()))?;
        if let Some(input) = opts.stdin {
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.as_bytes()).await?;
            }
        }

        let wait = child.wait_with_output();
        let cancel = opts.cancel.unwrap_or_default();
        let output = tokio::select! {
            out = async {
                match opts.timeout {
                    Some(t) => tokio::time::timeout(t, wait).await.map_err(|_| AppError::Timeout)?,
                    None => wait.await,
                }
                .map_err(AppError::from)
            } => out?,
            _ = cancel.cancelled() => return Err(AppError::Cancelled),
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.status.success() {
            return Ok(stdout);
        }
        // git reports some failures (e.g. rebase --continue) on stdout: same fallback as git.ts
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_owned()
        } else {
            format!(
                "Git failed (exit {}).",
                output
                    .status
                    .code()
                    .map_or("unknown".into(), |c| c.to_string())
            )
        };
        Err(AppError::Git {
            message,
            code: output.status.code(),
        })
    }
}
