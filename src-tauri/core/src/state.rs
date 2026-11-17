//! Port of electron/state.ts: one JSON object of string values in the app data folder.
//! Uses the same file name, so the Tauri build can read an existing Electron state file.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::Result;

pub type State = BTreeMap<String, String>;

pub fn state_file(dir: &Path) -> PathBuf {
    dir.join("gitverse-state.json")
}

/// Missing or corrupt file: start fresh rather than fail, like loadState().
pub fn load_state(dir: &Path) -> State {
    fs::read_to_string(state_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(map) => Some(
                map.into_iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned())))
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

/// Set (or with `None` remove) one key, written via a temp file + rename so a crash mid-write
/// never leaves a half-written file.
pub fn save_key(dir: &Path, key: &str, value: Option<&str>) -> Result<()> {
    let mut next = load_state(dir);
    match value {
        Some(v) => {
            next.insert(key.to_owned(), v.to_owned());
        }
        None => {
            next.remove(key);
        }
    }
    fs::create_dir_all(dir)?;
    let file = state_file(dir);
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(&next)?)?;
    fs::rename(tmp, file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_removes_keys() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_state(dir.path()).is_empty());
        save_key(dir.path(), "repos", "[\"a\"]".into()).unwrap();
        save_key(dir.path(), "theme", Some("dark")).unwrap();
        save_key(dir.path(), "theme", None).unwrap();
        let state = load_state(dir.path());
        assert_eq!(state.get("repos").map(String::as_str), Some("[\"a\"]"));
        assert!(!state.contains_key("theme"));
    }

    #[test]
    fn corrupt_file_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(state_file(dir.path()), "{not json").unwrap();
        assert!(load_state(dir.path()).is_empty());
    }
}
