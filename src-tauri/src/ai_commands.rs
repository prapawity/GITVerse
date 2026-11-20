//! `ai:*` commands (port of electron/ai/index.ts). Claude and ChatGPT run in Rust; Copilot runs in a
//! Node sidecar (core/src/ai/copilot.rs) because its SDK is Node-only.
use std::collections::HashMap;

use gitverse_core::hosting;
use std::sync::Mutex;
use std::time::Duration;

use gitverse_core::ai::{
    claude, copilot, err, openai, ErrKind, MessageResult, NMsg, Provider, ResolveResult, TurnResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::AppState;

/// Running turns, so `ai:abort` can cancel them.
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<u64, CancellationToken>>);

/// The Copilot sidecar client. Script: GITVERSE_COPILOT_SIDECAR, the bundled `copilot/` resource,
/// or the dev build in `<repo>/sidecar/`. Node: GITVERSE_NODE, the bundled one, or `node` on PATH.
pub fn copilot_client(
    handle: &tauri::AppHandle,
    secrets: std::sync::Arc<dyn gitverse_core::secrets::SecretStore>,
) -> copilot::Copilot {
    use tauri::Manager;
    const NAME: &str = "copilot-sidecar.mjs";
    let script = std::env::var_os("GITVERSE_COPILOT_SIDECAR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            let p = handle
                .path()
                .resource_dir()
                .ok()?
                .join("copilot")
                .join(NAME);
            p.is_file().then_some(p)
        })
        .or_else(|| {
            Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("sidecar")
                    .join(NAME),
            )
        });
    // release builds ship Node next to the app (tauri.release.conf.json externalBin)
    let bundled_node = std::env::current_exe().ok().and_then(|exe| {
        let p = exe.with_file_name(if cfg!(windows) { "node.exe" } else { "node" });
        p.is_file().then(|| p.to_string_lossy().into_owned())
    });
    let node = std::env::var("GITVERSE_NODE")
        .ok()
        .or(bundled_node)
        .unwrap_or_else(|| "node".into());
    let events = handle.clone();
    copilot::Copilot::new(node, script, secrets, move |event| match event {
        copilot::Event::Delta { req_id, text } => {
            let _ = events.emit("ai:delta", Delta { req_id, text });
        }
        copilot::Event::ToolCall(call) => {
            let _ = events.emit("ai:toolcall", call);
        }
    })
}

fn chatgpt(app: &AppState) -> openai::OpenAi {
    openai::OpenAi::new(app.secrets.clone(), app.openai.clone())
}

/// `{ ok: true, value } | { ok: false, message }`, like `wrap()` in index.ts.
fn wrap<T: Serialize>(r: Result<T, String>) -> Value {
    match r {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(message) => json!({ "ok": false, "message": message }),
    }
}

#[tauri::command]
pub fn ai_status(app: tauri::State<'_, AppState>) -> Value {
    let secrets = app.secrets.as_ref();
    json!({
        "claude": claude::status(secrets),
        "openai": chatgpt(&app).status(),
    })
}

#[tauri::command]
pub async fn ai_copilot_status(app: tauri::State<'_, AppState>) -> Result<Value, ()> {
    Ok(app.copilot.status().await)
}

#[tauri::command]
pub async fn ai_set_key(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    key: Option<String>,
) -> Result<Value, ()> {
    Ok(wrap(match provider {
        Provider::Claude => {
            claude::set_key(app.secrets.as_ref(), key.as_deref()).map_err(|e| e.to_string())
        }
        Provider::Openai => chatgpt(&app)
            .set_key(key.as_deref())
            .map_err(|e| e.to_string()),
        Provider::Copilot => app.copilot.set_token(key.as_deref()).await,
    }))
}

#[tauri::command]
pub async fn ai_models(app: tauri::State<'_, AppState>, provider: Provider) -> Result<Value, ()> {
    Ok(wrap(match provider {
        Provider::Claude => Ok(Vec::<String>::new()),
        Provider::Openai => chatgpt(&app).models().await,
        Provider::Copilot => app.copilot.models().await,
    }))
}

/// "Sign in with ChatGPT": opens the system browser and waits for the loopback redirect.
#[tauri::command]
pub async fn ai_openai_sign_in(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<Value, ()> {
    use tauri_plugin_opener::OpenerExt;
    let r = chatgpt(&app)
        .sign_in(|url| {
            let _ = handle.opener().open_url(url, None::<&str>);
        })
        .await;
    Ok(wrap(r))
}

#[tauri::command]
pub fn ai_openai_cancel(app: tauri::State<'_, AppState>) {
    chatgpt(&app).cancel_sign_in();
}

#[tauri::command]
pub fn ai_openai_sign_out(app: tauri::State<'_, AppState>) -> Result<(), gitverse_core::AppError> {
    chatgpt(&app).sign_out()
}

/// Open a Copilot sign-in step's URL, but only a github.com one (like openCopilotStep in index.ts).
fn open_step(handle: &tauri::AppHandle, step: Value) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    if step["kind"] == "open-url" {
        let url = url::Url::parse(step["url"].as_str().unwrap_or_default())
            .ok()
            .filter(|u| u.scheme() == "https" && u.host_str() == Some("github.com"))
            .ok_or("GitHub returned an unexpected sign-in address.")?;
        handle
            .opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(step)
}

#[tauri::command]
pub async fn ai_copilot_begin_login(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<Value, ()> {
    Ok(wrap(
        app.copilot
            .begin_login()
            .await
            .and_then(|s| open_step(&handle, s)),
    ))
}

#[tauri::command]
pub async fn ai_copilot_advance_login(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
) -> Result<Value, ()> {
    Ok(wrap(
        app.copilot
            .advance_login()
            .await
            .and_then(|s| open_step(&handle, s)),
    ))
}

#[tauri::command]
pub async fn ai_copilot_cancel_login(app: tauri::State<'_, AppState>) -> Result<(), ()> {
    app.copilot.cancel_login().await;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    req_id: u64,
    provider: Provider,
    conv_id: Option<u64>,
    model: Option<String>,
    messages: Vec<NMsg>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    req_id: u64,
    text: String,
}

#[tauri::command]
pub async fn ai_turn(
    handle: tauri::AppHandle,
    app: tauri::State<'_, AppState>,
    req: TurnRequest,
) -> Result<TurnResult, ()> {
    let cancel = CancellationToken::new();
    app.ai_requests
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.req_id, cancel.clone());
    let req_id = req.req_id;
    let emit = move |text: &str| {
        let _ = handle.emit(
            "ai:delta",
            Delta {
                req_id,
                text: text.to_owned(),
            },
        );
    };
    let result = match req.provider {
        Provider::Openai => {
            chatgpt(&app)
                .turn(&req.messages, req.model.clone(), &emit, &cancel)
                .await
        }
        Provider::Copilot => {
            app.copilot
                .turn(
                    req_id,
                    req.conv_id,
                    &req.messages,
                    req.model.clone(),
                    &cancel,
                )
                .await
        }
        Provider::Claude => {
            claude::Claude::new(app.secrets.as_ref())
                .turn(&req.messages, emit, &cancel)
                .await
        }
    };
    app.ai_requests
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&req_id);
    Ok(result)
}

#[tauri::command]
pub fn ai_abort(app: tauri::State<'_, AppState>, req_id: u64) {
    if let Some(cancel) = app
        .ai_requests
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&req_id)
    {
        cancel.cancel();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgedResult {
    text: String,
    is_error: bool,
}

/// Copilot runs its own tool loop and hands each call to the renderer (`ai:toolcall`); the
/// renderer answers here.
#[tauri::command]
pub async fn ai_tool_result(
    app: tauri::State<'_, AppState>,
    call_id: String,
    r: BridgedResult,
) -> Result<(), ()> {
    app.copilot.tool_result(&call_id, &r.text, r.is_error).await;
    Ok(())
}

/// Drop Copilot's session for a conversation.
#[tauri::command]
pub async fn ai_reset(app: tauri::State<'_, AppState>, conv_id: u64) -> Result<(), ()> {
    app.copilot.reset(conv_id).await;
    Ok(())
}

/// Cancel `cancel` after `limit`, like the timers in index.ts.
fn deadline(limit: Duration) -> CancellationToken {
    let cancel = CancellationToken::new();
    let timer = cancel.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(limit).await;
        timer.cancel();
    });
    cancel
}

#[tauri::command]
pub async fn ai_commit_message(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    model: Option<String>,
    diff: String,
) -> Result<MessageResult, ()> {
    if diff.trim().is_empty() || diff.encode_utf16().count() > 150_000 {
        return Ok(MessageResult::failed(err(
            ErrKind::Other,
            "Invalid staged diff or AI provider.",
        )));
    }
    let cancel = deadline(Duration::from_secs(180));
    Ok(match provider {
        Provider::Claude => {
            claude::Claude::new(app.secrets.as_ref())
                .commit_message(&diff, &cancel)
                .await
        }
        Provider::Openai => chatgpt(&app).commit_message(&diff, model, &cancel).await,
        Provider::Copilot => app.copilot.commit_message(&diff, model).await,
    })
}

#[tauri::command]
pub async fn ai_task(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    model: Option<String>,
    task: String,
    prompt: String,
) -> Result<MessageResult, ()> {
    let spec = gitverse_core::ai::spec();
    let system = match task.as_str() {
        "explain" => &spec.explain_system,
        "stash" => &spec.stash_system,
        "compose" => &spec.compose_system,
        _ => {
            return Ok(MessageResult::failed(err(
                ErrKind::Other,
                "Invalid AI request.",
            )))
        }
    };
    if prompt.trim().is_empty() || prompt.encode_utf16().count() > 150_000 {
        return Ok(MessageResult::failed(err(
            ErrKind::Other,
            "Invalid AI request.",
        )));
    }
    let cancel = deadline(Duration::from_secs(180));
    Ok(match provider {
        Provider::Claude => {
            claude::Claude::new(app.secrets.as_ref())
                .message(system, &prompt, 4096, &cancel)
                .await
        }
        Provider::Openai => chatgpt(&app).message(system, &prompt, model, &cancel).await,
        Provider::Copilot => app.copilot.task(&task, &prompt, model).await,
    })
}

#[tauri::command]
pub async fn ai_pull_request(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    model: Option<String>,
    prompt: String,
) -> Result<MessageResult, ()> {
    if prompt.trim().is_empty() || prompt.encode_utf16().count() > 150_000 {
        return Ok(MessageResult::failed(err(
            ErrKind::Other,
            "Invalid pull request material or AI provider.",
        )));
    }
    let cancel = deadline(Duration::from_secs(180));
    let system = &gitverse_core::ai::spec().pr_system;
    Ok(match provider {
        Provider::Claude => {
            claude::Claude::new(app.secrets.as_ref())
                .message(system, &prompt, 2048, &cancel)
                .await
        }
        Provider::Openai => chatgpt(&app).message(system, &prompt, model, &cancel).await,
        Provider::Copilot => app.copilot.pull_request(&prompt, model).await,
    })
}

#[tauri::command]
pub fn hosting_token_status(
    app: tauri::State<'_, AppState>,
    kind: hosting::HostKind,
    host: String,
) -> bool {
    hosting::check_host(kind, &host).is_ok()
        && app.secrets.get(&hosting::token_key(kind, &host)).is_some()
}

#[tauri::command]
pub fn hosting_set_token(
    app: tauri::State<'_, AppState>,
    kind: hosting::HostKind,
    host: String,
    token: Option<String>,
) -> Result<(), gitverse_core::AppError> {
    hosting::check_host(kind, &host)?;
    let token = token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    app.secrets.set(&hosting::token_key(kind, &host), token)
}

#[tauri::command]
pub fn hosting_open(
    handle: tauri::AppHandle,
    kind: hosting::HostKind,
    host: String,
    url: String,
) -> Result<(), gitverse_core::AppError> {
    use tauri_plugin_opener::OpenerExt;
    if !hosting::web_url_allowed(kind, &host, &url) {
        return Err(gitverse_core::AppError::Invalid(
            "Refusing to open a link outside this repository's host.".into(),
        ));
    }
    handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| gitverse_core::AppError::Invalid(e.to_string()))
}

#[tauri::command]
pub async fn hosting_connect(
    app: tauri::State<'_, AppState>,
    kind: hosting::HostKind,
    host: String,
    token: Option<String>,
    repo: Option<String>,
    profile_ids: Vec<String>,
) -> Result<hosting::ConnectResult, gitverse_core::AppError> {
    let pushed = match repo {
        Some(repo) => profile_ids
            .iter()
            .filter_map(|id| app.secrets.get(&push_token_key(&repo, id)))
            .collect(),
        None => vec![],
    };
    hosting::connect(app.secrets.as_ref(), kind, &host, token, pushed).await
}

#[tauri::command]
pub async fn hosting_request(
    app: tauri::State<'_, AppState>,
    request: hosting::HostRequest,
) -> Result<hosting::HostResponse, gitverse_core::AppError> {
    hosting::request(app.secrets.as_ref(), request).await
}

#[tauri::command]
pub async fn ai_resolve_conflict(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    model: Option<String>,
    prompt: String,
    count: usize,
) -> Result<ResolveResult, ()> {
    let cancel = deadline(Duration::from_secs(4 * 60));
    let result = match provider {
        Provider::Claude => {
            claude::Claude::new(app.secrets.as_ref())
                .resolve(&prompt, &cancel)
                .await
        }
        Provider::Openai => chatgpt(&app).resolve(&prompt, model, &cancel).await,
        Provider::Copilot => app.copilot.resolve(&prompt, model).await,
    };
    Ok(result.sanitized(count))
}

// ---- saved HTTPS push tokens (push:tokenStatus / push:setToken) ----

/// Same key as main.ts: `push.token.` + sha256 of JSON `[repo, id]`.
pub fn push_token_key(repo: &str, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_string(&[repo, id]).unwrap_or_default();
    format!(
        "push.token.{}",
        hex::encode(Sha256::digest(json.as_bytes()))
    )
}

#[tauri::command]
pub fn push_token_status(app: tauri::State<'_, AppState>, repo: String, id: String) -> bool {
    app.secrets.get(&push_token_key(&repo, &id)).is_some()
}

#[tauri::command]
pub fn push_set_token(
    app: tauri::State<'_, AppState>,
    repo: String,
    id: String,
    token: Option<String>,
) -> Result<(), gitverse_core::AppError> {
    let token = token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    app.secrets.set(&push_token_key(&repo, &id), token)
}

#[cfg(test)]
mod tests {
    use super::push_token_key;

    /// Matches createHash('sha256').update(JSON.stringify([repo, id])).digest('hex') in main.ts.
    #[test]
    fn push_token_key_matches_electron() {
        assert_eq!(
            push_token_key("C:\\repo", "p1"),
            "push.token.f7cb86c5b34d4d2d5be01a20130ff13456ab98d3fb33277fd202ec281abdcaad"
        );
    }
}
