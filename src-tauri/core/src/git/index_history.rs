//! Undo/redo for stage and unstage actions (electron/git/git.ts `indexHistory`).
//!
//! Before and after each tracked index change we snapshot the index file bytes plus what git
//! reports about it; undo/redo restores the bytes only if the index still matches what we left.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    index: Option<Vec<u8>>,
    head: String,
    entries: String,
    flags: String,
}

impl Snapshot {
    fn same(&self, other: &Snapshot) -> bool {
        self.head == other.head
            && self.entries == other.entries
            && self.flags == other.flags
            && self.index.is_none() == other.index.is_none()
    }
}

#[derive(Debug, Clone)]
struct Change {
    before: Snapshot,
    after: Snapshot,
}

#[derive(Debug, Default)]
struct History {
    undo: Vec<Change>,
    redo: Vec<Change>,
}

/// Per-repository history, kept in memory for the app's lifetime (like the TS Map).
#[derive(Debug, Default)]
pub struct IndexHistory(Mutex<HashMap<PathBuf, History>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UndoState {
    pub undo: bool,
    pub redo: bool,
}

pub(crate) async fn index_file(git: &GitRunner, cwd: &Path) -> Result<PathBuf> {
    Ok(cwd.join(
        git.run(
            cwd,
            &["rev-parse", "--git-path", "index"],
            RunOpts::default(),
        )
        .await?
        .trim(),
    ))
}

pub(crate) async fn snapshot(git: &GitRunner, cwd: &Path, file: &Path) -> Result<Snapshot> {
    let index = match std::fs::read(file) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let head = git
        .run(cwd, &["rev-parse", "--verify", "HEAD"], RunOpts::default())
        .await
        .unwrap_or_default();
    let entries = git
        .run(
            cwd,
            &["ls-files", "--stage", "-v", "-z"],
            RunOpts::default(),
        )
        .await?;
    let debug = git
        .run(cwd, &["ls-files", "--debug", "-z"], RunOpts::default())
        .await?;
    let flags = debug
        .split("\tflags: ")
        .skip(1)
        .map(|rest| {
            rest.chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(Snapshot {
        index,
        head: head.trim().to_owned(),
        entries,
        flags,
    })
}

impl IndexHistory {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, History>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record a change if it actually changed the index (keeps the last 20; clears redo).
    pub(crate) fn record(&self, cwd: &Path, before: Snapshot, after: Snapshot) {
        if before.same(&after) {
            return;
        }
        let mut map = self.lock();
        let history = map.entry(cwd.to_path_buf()).or_default();
        history.undo.push(Change { before, after });
        if history.undo.len() > 20 {
            history.undo.remove(0);
        }
        history.redo.clear();
    }

    pub async fn state(&self, git: &GitRunner, cwd: &Path) -> Result<UndoState> {
        let (last_undo, last_redo) = {
            let map = self.lock();
            let Some(h) = map.get(cwd) else {
                return Ok(UndoState {
                    undo: false,
                    redo: false,
                });
            };
            (
                h.undo.last().map(|c| c.after.clone()),
                h.redo.last().map(|c| c.before.clone()),
            )
        };
        let now = snapshot(git, cwd, &index_file(git, cwd).await?).await?;
        Ok(UndoState {
            undo: last_undo.is_some_and(|s| now.same(&s)),
            redo: last_redo.is_some_and(|s| now.same(&s)),
        })
    }

    pub async fn tracked_stage(
        &self,
        git: &GitRunner,
        cwd: &Path,
        stage: bool,
        paths: &[String],
    ) -> Result<UndoState> {
        let file = index_file(git, cwd).await?;
        let before = snapshot(git, cwd, &file).await?;
        if stage {
            super::stage(git, cwd, paths).await?;
        } else {
            super::unstage(git, cwd, paths).await?;
        }
        let after = snapshot(git, cwd, &file).await?;
        self.record(cwd, before, after);
        self.state(git, cwd).await
    }

    pub async fn move_history(&self, git: &GitRunner, cwd: &Path, undo: bool) -> Result<UndoState> {
        let change = {
            let map = self.lock();
            let stack = map.get(cwd).map(|h| if undo { &h.undo } else { &h.redo });
            stack.and_then(|s| s.last().cloned())
        }
        .ok_or_else(|| AppError::Invalid("No stage or unstage action to undo or redo.".into()))?;
        let (expected, target) = if undo {
            (&change.after, &change.before)
        } else {
            (&change.before, &change.after)
        };
        let file = index_file(git, cwd).await?;
        let lock = PathBuf::from(format!("{}.lock", file.display()));
        // Take git's own index lock so a concurrent git command cannot interleave.
        let mut handle = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
        {
            Ok(h) => h,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(AppError::Invalid(
                    "Git is using the index. Wait and try again.".into(),
                ))
            }
            Err(e) => return Err(e.into()),
        };
        let applied = async {
            if !snapshot(git, cwd, &file).await?.same(expected) {
                return Err(AppError::Invalid(
                    "The index or HEAD changed since this action. Undo/redo was not applied."
                        .into(),
                ));
            }
            match &target.index {
                Some(bytes) => {
                    handle.write_all(bytes)?;
                    drop(handle);
                    std::fs::rename(&lock, &file)?;
                }
                None => {
                    drop(handle);
                    let _ = std::fs::remove_file(&file);
                    let _ = std::fs::remove_file(&lock);
                }
            }
            Ok(())
        }
        .await;
        if applied.is_err() {
            let _ = std::fs::remove_file(&lock);
        }
        applied?;
        {
            let mut map = self.lock();
            if let Some(h) = map.get_mut(cwd) {
                let moved = if undo { h.undo.pop() } else { h.redo.pop() };
                if let Some(c) = moved {
                    if undo {
                        h.redo.push(c)
                    } else {
                        h.undo.push(c)
                    }
                }
            }
        }
        self.state(git, cwd).await
    }
}
