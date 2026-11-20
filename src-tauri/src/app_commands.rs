//! Folder scans, opening files in the user's apps, and license notices (the remaining `repo:*` and
//! `app:*` handlers of electron/main.ts).
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use gitverse_core::scan::{scan_repositories, ScanProgress, ScanResult};
use gitverse_core::AppError;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use crate::AppState;

/// Folder scans in progress, by request id. Several can run at once (like the Electron backend):
/// a background Group Sync must not block the user opening a folder.
#[derive(Default)]
pub struct Scans(Mutex<HashMap<String, CancellationToken>>);

const MAX_SCANS: usize = 8;

#[derive(Clone, Serialize)]
struct Progress {
    id: String,
    progress: ScanProgress,
}

#[tauri::command]
pub async fn repo_find_repositories(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
    folder: String,
    id: String,
) -> Result<ScanResult, AppError> {
    let cancel = {
        let mut scans = app.scans.0.lock().unwrap_or_else(|e| e.into_inner());
        if id.is_empty() || scans.contains_key(&id) {
            return Err(AppError::Invalid(
                "A folder scan with this request is already running, or the request is invalid."
                    .into(),
            ));
        }
        if scans.len() >= MAX_SCANS {
            return Err(AppError::Invalid(
                "Too many folder scans are running. Try again in a moment.".into(),
            ));
        }
        let c = CancellationToken::new();
        scans.insert(id.clone(), c.clone());
        c
    };
    let result = scan_repositories(&folder, &cancel, |progress| {
        let _ = handle.emit(
            "repo:scanProgress",
            Progress {
                id: id.clone(),
                progress,
            },
        );
    })
    .await;
    app.scans
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result.map_err(AppError::Invalid)
}

#[tauri::command]
pub fn repo_cancel_scan(app: tauri::State<'_, AppState>, id: String) {
    if let Some(cancel) = app
        .scans
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        cancel.cancel();
    }
}

/// `rel` inside `cwd`, or None when it would escape the repository.
pub fn inside(cwd: &Path, rel: &str) -> Option<PathBuf> {
    let mut out: PathBuf = cwd.components().collect();
    let base = out.clone();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (out != base && out.starts_with(&base)).then_some(out)
}

/// Open a conflicted file in the user's editor; refuse paths that escape the repository.
#[tauri::command]
pub fn repo_open_file(handle: tauri::AppHandle, cwd: String, rel: String) -> Result<(), AppError> {
    let full = inside(Path::new(&cwd), &rel)
        .ok_or_else(|| AppError::Invalid("Path is outside the repository".into()))?;
    handle
        .opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Invalid(e.to_string()))
}

#[tauri::command]
pub fn app_open_third_party_notices(handle: tauri::AppHandle) -> Result<(), AppError> {
    const NAME: &str = "THIRD_PARTY_NOTICES.txt";
    let bundled = handle.path().resource_dir().ok().map(|d| d.join(NAME));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("build-notices")
        .join(NAME);
    let path = bundled
        .filter(|p| p.is_file())
        .or_else(|| dev.is_file().then_some(dev))
        .ok_or_else(|| {
            AppError::Invalid("Third-party notices are unavailable in this build.".into())
        })?;
    handle
        .opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Invalid(e.to_string()))
}

/// The Tauri build ships no Electron or Chromium; the system web view's notices come with the OS.
#[tauri::command]
pub fn app_open_runtime_notice(kind: String) -> Result<(), AppError> {
    Err(AppError::Invalid(match kind.as_str() {
        "electron" | "chromium" => "This build does not include Electron or Chromium: it uses the system web view, whose license notices come with your operating system.".into(),
        _ => "Unknown runtime notice.".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::inside;
    use std::path::Path;

    #[test]
    fn open_file_stays_inside_the_repository() {
        let repo = Path::new("/r/repo");
        assert_eq!(
            inside(repo, "src/a.ts").unwrap(),
            Path::new("/r/repo/src/a.ts")
        );
        assert_eq!(
            inside(repo, "src/../b.ts").unwrap(),
            Path::new("/r/repo/b.ts")
        );
        assert!(inside(repo, "../other/x").is_none());
        assert!(inside(repo, "/etc/passwd").is_none());
        assert!(inside(repo, ".").is_none());
        assert!(inside(repo, "a/../..").is_none());
    }
}

/// "Open in…": editors and IDEs found on this computer (`electron/editors.ts`).
struct EditorDef {
    id: &'static str,
    name: &'static str,
    apps: &'static [&'static str],
    cli: &'static [&'static str],
}

const EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "vscode",
        name: "Visual Studio Code",
        apps: &["Visual Studio Code"],
        cli: &["code"],
    },
    EditorDef {
        id: "cursor",
        name: "Cursor",
        apps: &["Cursor"],
        cli: &["cursor"],
    },
    EditorDef {
        id: "windsurf",
        name: "Windsurf",
        apps: &["Windsurf"],
        cli: &["windsurf"],
    },
    EditorDef {
        id: "zed",
        name: "Zed",
        apps: &["Zed"],
        cli: &["zed"],
    },
    EditorDef {
        id: "idea",
        name: "IntelliJ IDEA",
        apps: &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        cli: &["idea"],
    },
    EditorDef {
        id: "webstorm",
        name: "WebStorm",
        apps: &["WebStorm"],
        cli: &["webstorm"],
    },
    EditorDef {
        id: "android-studio",
        name: "Android Studio",
        apps: &["Android Studio"],
        cli: &["studio"],
    },
    EditorDef {
        id: "xcode",
        name: "Xcode",
        apps: &["Xcode"],
        cli: &[],
    },
    EditorDef {
        id: "sublime",
        name: "Sublime Text",
        apps: &["Sublime Text"],
        cli: &["subl"],
    },
    EditorDef {
        id: "fleet",
        name: "Fleet",
        apps: &["Fleet"],
        cli: &["fleet"],
    },
];

enum Launch {
    MacApp(PathBuf),
    Cli(PathBuf),
}

fn locate_editor(e: &EditorDef) -> Option<Launch> {
    if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        for app in e.apps {
            for dir in [PathBuf::from("/Applications"), home.join("Applications")] {
                let p = dir.join(format!("{app}.app"));
                if p.exists() {
                    return Some(Launch::MacApp(p));
                }
            }
        }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path)
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from))
        .collect();
    for cli in e.cli {
        let names: Vec<String> = if cfg!(windows) {
            vec![format!("{cli}.cmd"), format!("{cli}.exe")]
        } else {
            vec![(*cli).to_owned()]
        };
        for dir in &dirs {
            for n in &names {
                let p = dir.join(n);
                if p.is_file() {
                    return Some(Launch::Cli(p));
                }
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct EditorInfo {
    id: &'static str,
    name: &'static str,
}

#[tauri::command]
pub fn app_editors() -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .filter(|e| locate_editor(e).is_some())
        .map(|e| EditorInfo {
            id: e.id,
            name: e.name,
        })
        .collect()
}

#[tauri::command]
pub fn app_open_in(editor: String, target: String) -> Result<(), AppError> {
    let e = EDITORS
        .iter()
        .find(|e| e.id == editor)
        .ok_or_else(|| AppError::Invalid("Unknown editor.".into()))?;
    let target_path = Path::new(&target);
    if !target_path.is_absolute() || !target_path.exists() {
        return Err(AppError::Invalid(
            "That file or folder does not exist.".into(),
        ));
    }
    let launch = locate_editor(e)
        .ok_or_else(|| AppError::Invalid(format!("{} was not found on this computer.", e.name)))?;
    let mut cmd = match launch {
        Launch::MacApp(app) => {
            let mut c = std::process::Command::new("open");
            c.arg("-a").arg(app).arg(target_path);
            c
        }
        Launch::Cli(cli) if cfg!(windows) => {
            // .cmd launchers need a shell on Windows
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(cli).arg(target_path);
            c
        }
        Launch::Cli(cli) => {
            let mut c = std::process::Command::new(cli);
            c.arg(target_path);
            c
        }
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::Invalid(format!("Could not open {}: {err}", e.name)))
}
