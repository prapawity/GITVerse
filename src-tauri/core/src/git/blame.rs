//! `fileBlame` and `fileHistory`.
use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::{GitRunner, RunOpts};
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlameLine {
    pub hash: String,
    pub author: String,
    /// Milliseconds since the epoch, like JS `Date`.
    pub time: u64,
}

fn blame_header(line: &str) -> Option<&str> {
    // "<40 hex> <orig line> <final line>[ <group size>]"
    let (hash, rest) = line.split_at_checked(40)?;
    let mut nums = rest.strip_prefix(' ')?.split(' ');
    let is_num =
        |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    (hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && is_num(nums.next())
        && is_num(nums.next()))
    .then_some(hash)
}

pub fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut meta: HashMap<String, (String, u64)> = HashMap::new();
    let mut lines = Vec::new();
    let mut cur = String::new();
    for l in out.split('\n') {
        if l.starts_with('\t') {
            let (author, time) = meta.get(&cur).cloned().unwrap_or_default();
            lines.push(BlameLine {
                hash: cur.clone(),
                author,
                time,
            });
        } else if let Some(hash) = blame_header(l) {
            cur = hash.to_owned();
            meta.entry(cur.clone()).or_default();
        } else if let Some(author) = l.strip_prefix("author ") {
            meta.entry(cur.clone()).or_default().0 = author.to_owned();
        } else if let Some(t) = l.strip_prefix("author-time ") {
            meta.entry(cur.clone()).or_default().1 = t.trim().parse::<u64>().unwrap_or(0) * 1000;
        }
    }
    lines
}

pub async fn file_blame(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    path: &str,
) -> Result<Vec<BlameLine>> {
    Ok(parse_blame(
        &git.run(
            cwd,
            &["blame", "--porcelain", hash, "--", path],
            RunOpts::default(),
        )
        .await?,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileHistoryEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// the file's path in this commit (differs before a rename)
    pub path: String,
}

pub async fn file_history(
    git: &GitRunner,
    cwd: &Path,
    hash: &str,
    path: &str,
) -> Result<Vec<FileHistoryEntry>> {
    // --name-only gives the file's path in each commit, which differs before a rename (--follow)
    let out = git
        .run(
            cwd,
            &[
                "log",
                "--follow",
                "--name-only",
                "-n200",
                "--format=%x1e%H%x1f%an%x1f%aI%x1f%s",
                hash,
                "--",
                path,
            ],
            RunOpts::default(),
        )
        .await?;
    Ok(out
        .split('\u{1e}')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|record| {
            let mut lines = record.lines().filter(|l| !l.is_empty());
            let header = lines.next().unwrap_or_default();
            let file = lines.last().unwrap_or(path).to_owned();
            let mut f = header.split('\u{1f}');
            let mut next = || f.next().unwrap_or_default().to_owned();
            FileHistoryEntry {
                hash: next(),
                author: next(),
                date: next(),
                subject: next(),
                path: file,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_commits_reuse_metadata() {
        let h = "a".repeat(40);
        let out = format!("{h} 1 1 2\nauthor Ada\nauthor-mail <a@x>\nauthor-time 10\n\tline one\n{h} 2 2\n\tline two\n");
        let lines = parse_blame(&out);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[1],
            BlameLine {
                hash: h,
                author: "Ada".into(),
                time: 10_000
            }
        );
    }
}
