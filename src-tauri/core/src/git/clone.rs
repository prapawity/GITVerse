//! `clone` with live progress (electron/git/git.ts). Only HTTPS and SSH URLs without embedded
//! credentials are accepted; the destination must be a new folder under an existing parent.
use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::{AppError, Result};

fn invalid(m: &str) -> AppError {
    AppError::Invalid(m.to_owned())
}

pub fn validate_clone_url(url: &str) -> Result<()> {
    let bad = || invalid("Enter a valid HTTPS or SSH repository URL.");
    if url.is_empty() || url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return Err(bad());
    }
    // A Windows drive path (C:\repo, C:/repo) also looks like `host:path`; it is local, not SSH.
    let b = url.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    {
        return Err(bad());
    }
    let scp = !url.contains("://") && {
        let (user, rest) = match url.split_once('@') {
            Some((u, r))
                if !u.is_empty()
                    && u.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) =>
            {
                (Some(u), r)
            }
            _ => (None, url),
        };
        let _ = user;
        rest.split_once(':').is_some_and(|(host, path)| {
            !host.is_empty()
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
                && !path.is_empty()
        })
    };
    if scp {
        return Ok(());
    }
    let parsed = url::Url::parse(url).map_err(|_| bad())?;
    let https = parsed.scheme() == "https";
    if !(https || parsed.scheme() == "ssh")
        || parsed.host_str().is_none_or(str::is_empty)
        || parsed.path().is_empty()
        || (https && (!parsed.username().is_empty() || parsed.password().is_some()))
        || parsed.password().is_some()
    {
        return Err(invalid(
            "Use an HTTPS or SSH repository URL without embedded credentials.",
        ));
    }
    Ok(())
}

pub async fn clone(url: &str, destination: &str, mut progress: impl FnMut(&str)) -> Result<()> {
    clone_with_credentials(url, destination, None, &mut progress).await
}

pub async fn clone_with_credentials(
    url: &str,
    destination: &str,
    credentials: Option<(&str, &str)>,
    mut progress: impl FnMut(&str),
) -> Result<()> {
    validate_clone_url(url)?;
    let dest = Path::new(destination);
    if !dest.is_absolute() || destination.contains('\0') || dest.parent().is_none() {
        return Err(invalid("Enter an absolute destination folder path."));
    }
    if dest.exists() {
        return Err(invalid(
            "Destination already exists. Choose a new folder path.",
        ));
    }
    let parent = dest.parent().filter(|p| p.is_dir()).ok_or_else(|| {
        invalid("The destination parent folder does not exist or cannot be accessed.")
    })?;
    let mut cmd = Command::new("git");
    let mut _auth_dir = None;
    if let Some((username, password)) = credentials {
        if !url.starts_with("https://") || username.is_empty() || password.is_empty() {
            return Err(invalid("Enter HTTPS credentials."));
        }
        if cfg!(windows) {
            return Err(invalid("Use the system credential manager on Windows."));
        }
        let dir = tempfile::Builder::new()
            .prefix("gitverse-auth-")
            .tempdir()?;
        let askpass = dir.path().join("askpass");
        std::fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in *sername*) printf \"%s\\n\" \"$GITVERSE_PUSH_USER\" ;; *) printf \"%s\\n\" \"$GITVERSE_PUSH_TOKEN\" ;; esac\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o700))?;
        }
        cmd.args(["-c", "credential.helper="])
            .env("GIT_ASKPASS", askpass)
            .env("GITVERSE_PUSH_USER", username)
            .env("GITVERSE_PUSH_TOKEN", password);
        _auth_dir = Some(dir);
    }
    cmd.args(["clone", "--progress", "--", url, destination])
        .current_dir(parent)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(
            "GIT_SSH_COMMAND",
            std::env::var("GIT_SSH_COMMAND")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "ssh -o BatchMode=yes".into()),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| AppError::Spawn(e.to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Spawn("no stderr".into()))?;
    let mut output = String::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = stderr.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buf[..n]);
        output.push_str(&chunk);
        if output.len() > 16_000 {
            let cut = output.len() - 16_000;
            let cut = (cut..output.len())
                .find(|i| output.is_char_boundary(*i))
                .unwrap_or(cut);
            output.drain(..cut);
        }
        if let Some(line) = chunk.split(['\r', '\n']).rfind(|l| !l.is_empty()) {
            progress(line);
        }
    }
    let status = child.wait().await?;
    if status.success() {
        return Ok(());
    }
    let message = output.trim();
    Err(AppError::Git {
        message: if message.is_empty() {
            format!(
                "Git clone failed (exit {}).",
                status.code().map_or("unknown".into(), |c| c.to_string())
            )
        } else {
            message.to_owned()
        },
        code: status.code(),
    })
}

#[cfg(test)]
mod tests {
    use super::validate_clone_url;

    #[test]
    fn accepts_https_and_ssh_only() {
        for ok in [
            "https://github.com/a/b.git",
            "ssh://git@github.com/a/b.git",
            "git@github.com:a/b.git",
            "github.com:a/b.git",
        ] {
            assert!(validate_clone_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-x",
            "file:///tmp/r",
            "C:\\repos\\r.git",
            "C:/repos/r.git",
            "/tmp/repo",
            "https://u:p@h/r",
            "a b",
        ] {
            assert!(validate_clone_url(bad).is_err(), "{bad}");
        }
    }
}
