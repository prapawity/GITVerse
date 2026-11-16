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
    /// Exit codes other than 0 that still mean success (e.g. 1 for `diff --no-index` with changes).
    pub ok_codes: Vec<i32>,
    /// Skip the `-c user.name/email` identity (read-only commands that never write commits).
    pub no_identity: bool,
}

impl RunOpts {
    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_owned(), value.to_owned()));
        self
    }
    pub fn ok_code(mut self, code: i32) -> Self {
        self.ok_codes.push(code);
        self
    }
}

#[derive(Clone)]
pub struct GitRunner {
    bin: PathBuf,
    identity: Arc<RwLock<Option<Identity>>>,
    /// Applied to every command, before per-call env (tests use it to isolate from user config).
    base_env: Arc<Vec<(String, String)>>,
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
            base_env: Arc::new(Vec::new()),
        }
    }

    pub fn with_base_env(mut self, env: Vec<(String, String)>) -> Self {
        self.base_env = Arc::new(env);
        self
    }

    /// Like `run`, but only reports whether git exited successfully (e.g. `rev-parse --verify`).
    pub async fn succeeds(&self, cwd: &Path, args: &[&str]) -> bool {
        self.run(cwd, args, RunOpts::default()).await.is_ok()
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
            .envs(self.base_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
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
        let ok = output.status.success()
            || output
                .status
                .code()
                .is_some_and(|c| opts.ok_codes.contains(&c));
        if ok {
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
