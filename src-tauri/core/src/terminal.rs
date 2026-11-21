//! Integrated terminal (replaces electron/terminal.ts and its node-pty / Python / pipe fallbacks).
//!
//! `portable-pty` gives a real PTY everywhere (ConPTY on Windows, openpty on macOS/Linux), so
//! colours, line editing, full-screen tools and resize work without native Node modules.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{AppError, Result};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Owns every open terminal for the app; dropping it kills them.
#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    seq: AtomicU32,
}

fn clamp(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(20),
        rows: rows.max(5),
        pixel_width: 0,
        pixel_height: 0,
    }
}

const KNOWN_SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "tcsh",
    "csh",
    "nu",
    "elvish",
    "xonsh",
    "pwsh",
    "powershell",
    "cmd",
    "wsl",
    "git-bash",
];

/// Same rule as allowedShell() in TS: a custom shell must be an absolute path to a regular file
/// named like a shell, or listed in /etc/shells.
fn allowed_shell(custom: &str) -> bool {
    let p = Path::new(custom);
    if !p.is_absolute() || !p.is_file() {
        return false;
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    if KNOWN_SHELLS.contains(&name) {
        return true;
    }
    std::fs::read_to_string("/etc/shells")
        .map(|s| s.lines().any(|l| l.trim() == custom))
        .unwrap_or(false)
}

/// Same choice as shellPath() in TS: an allowed custom shell, else the platform default.
pub fn shell_path(custom: Option<&str>) -> PathBuf {
    if let Some(c) = custom.filter(|c| !c.is_empty() && allowed_shell(c)) {
        return PathBuf::from(c);
    }
    if cfg!(windows) {
        return std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| "powershell.exe".into());
    }
    if let Some(s) = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|s| s.exists())
    {
        return s;
    }
    if Path::new("/bin/zsh").exists() {
        "/bin/zsh".into()
    } else {
        "/bin/bash".into()
    }
}

/// Decode a byte stream as UTF-8 without splitting multi-byte characters across chunks.
struct Utf8Stream(Vec<u8>);

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        match std::str::from_utf8(&self.0) {
            Ok(s) => {
                let out = s.to_owned();
                self.0.clear();
                out
            }
            Err(e) if e.error_len().is_none() => {
                // incomplete sequence at the end: keep it for the next chunk
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&self.0[..valid]).into_owned();
                self.0.drain(..valid);
                out
            }
            Err(_) => {
                let out = String::from_utf8_lossy(&self.0).into_owned();
                self.0.clear();
                out
            }
        }
    }
}

impl Terminals {
    /// Start a shell. Output arrives through `on_data(id, text)`; `on_exit(id, code)` runs once.
    pub fn spawn(
        &self,
        cwd: &Path,
        cols: u16,
        rows: u16,
        shell: Option<&str>,
        on_data: impl Fn(u32, String) + Send + 'static,
        on_exit: impl Fn(u32, i32) + Send + 'static,
    ) -> Result<u32> {
        let pair = native_pty_system()
            .openpty(clamp(cols, rows))
            .map_err(spawn_err)?;
        let shell = shell_path(shell);
        let mut cmd = CommandBuilder::new(&shell);
        if !cfg!(windows) {
            cmd.arg("-l");
        }
        let cwd = if cwd.is_absolute() && cwd.is_dir() {
            cwd.to_path_buf()
        } else {
            home()
        };
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(spawn_err)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(spawn_err)?;
        let writer = pair.master.take_writer().map_err(spawn_err)?;
        let killer = child.clone_killer();

        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id,
                Session {
                    master: pair.master,
                    writer,
                    killer,
                },
            );

        // Reader: forward output until the PTY closes.
        let reader_thread = std::thread::Builder::new()
            .name(format!("gitverse-term-{id}-read"))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                let mut utf8 = Utf8Stream(Vec::new());
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let text = utf8.push(&buf[..n]);
                    if !text.is_empty() {
                        on_data(id, text);
                    }
                }
            })
            .map_err(|e| AppError::Spawn(e.to_string()))?;

        // Waiter: when the shell exits, close the PTY (ConPTY only ends the output stream then),
        // let the reader drain, and report the exit code once.
        let sessions = Arc::clone(&self.sessions);
        std::thread::Builder::new()
            .name(format!("gitverse-term-{id}-wait"))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(0);
                drop(
                    sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id),
                );
                let _ = reader_thread.join();
                on_exit(id, code);
            })
            .map_err(|e| AppError::Spawn(e.to_string()))?;
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        if let Some(s) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&id)
        {
            s.writer.write_all(data.as_bytes())?;
            s.writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        if let Some(s) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
        {
            s.master
                .resize(clamp(cols, rows))
                .map_err(|e| AppError::Spawn(e.to_string()))?;
        }
        Ok(())
    }

    pub fn kill(&self, id: u32) {
        if let Some(mut s) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            let _ = s.killer.kill();
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect();
        for id in ids {
            self.kill(id);
        }
    }

    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn spawn_err(e: impl std::fmt::Display) -> AppError {
    AppError::Spawn(format!("could not start terminal: {e}"))
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn custom_shell_must_be_an_absolute_known_shell() {
        assert!(!allowed_shell("zsh"));
        assert!(!allowed_shell("/definitely/missing/zsh"));
        if cfg!(unix) {
            assert!(allowed_shell("/bin/sh"));
            assert!(!allowed_shell("/usr/bin/env"));
            assert_eq!(shell_path(Some("/usr/bin/env")), shell_path(None));
        }
    }

    #[test]
    fn utf8_stream_keeps_split_characters_together() {
        let mut s = Utf8Stream(Vec::new());
        let bytes = "ไทย ✓".as_bytes();
        let (a, b) = bytes.split_at(2); // inside the first Thai character
        assert_eq!(s.push(a), "");
        assert_eq!(s.push(b), "ไทย ✓");
    }

    /// Smoke test like scripts/terminal-pty-smoke.cjs: real shell, input, output, resize, exit.
    #[test]
    fn runs_an_interactive_shell() {
        let terms = Terminals::default();
        let (tx, rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let shell = if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or("cmd.exe".into())
        } else {
            "/bin/sh".into()
        };
        let id = terms
            .spawn(
                &std::env::temp_dir(),
                80,
                24,
                Some(&shell),
                move |_, d| {
                    let _ = tx.send(d);
                },
                move |_, c| {
                    let _ = exit_tx.send(c);
                },
            )
            .unwrap();
        terms.resize(id, 100, 30).unwrap();
        // the marker is split so the echoed command line itself never matches
        let cmd = if cfg!(windows) {
            "echo PTY_%ComSpec:~0,0%SMOKE_OK\r\n"
        } else {
            "printf 'PTY_%s_OK\\n' SMOKE\n"
        };
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(d) = rx.try_recv() {
            if d.contains("\x1b[6n") {
                terms.write(id, "\x1b[1;1R").unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        terms.write(id, cmd).unwrap();
        let mut output = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !output.contains("PTY_SMOKE_OK") {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(d) => {
                    // ConPTY asks for the cursor position (DSR) before starting the shell;
                    // xterm.js answers this in the app, so answer it here like a terminal would.
                    if d.contains("\x1b[6n") {
                        terms.write(id, "\x1b[1;1R").unwrap();
                    }
                    output.push_str(&d);
                }
                Err(_) => panic!("no PTY_SMOKE_OK in output: {output:?}"),
            }
        }
        terms.write(id, "exit\r\n").unwrap();
        exit_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("shell exits");
        assert!(terms.is_empty(), "session is removed after exit");
    }
}
