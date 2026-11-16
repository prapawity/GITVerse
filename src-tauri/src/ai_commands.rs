//! `ai:*` commands (port of electron/ai/index.ts). Claude runs in Rust; OpenAI and Copilot follow
//! in later migration steps and report that clearly until then.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use gitverse_core::ai::{
    claude, err, ErrKind, MessageResult, NMsg, Provider, ResolveResult, TurnResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::AppState;

/// Running turns, so `ai:abort` can cancel them.
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<u64, CancellationToken>>);

const LATER: &str = "is not available in the Tauri build yet (Rust migration in progress).";

fn not_yet(provider: Provider) -> String {
    let name = match provider {
        Provider::Claude => "Claude",
        Provider::Openai => "ChatGPT",
        Provider::Copilot => "GitHub Copilot",
    };
    format!("{name} {LATER}")
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
        "openai": {
            "signedIn": false, "account": null, "planUsage": false,
            "hasApiKey": false, "signingIn": false, "canEncrypt": secrets.available(),
        },
    })
}

#[tauri::command]
pub fn ai_copilot_status(app: tauri::State<'_, AppState>) -> Value {
    json!({
        "hasToken": false, "canEncrypt": app.secrets.available(), "available": false,
        "authenticated": false, "login": null, "authType": null, "message": not_yet(Provider::Copilot),
    })
}

#[tauri::command]
pub fn ai_set_key(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    key: Option<String>,
) -> Value {
    wrap(match provider {
        Provider::Claude => {
            claude::set_key(app.secrets.as_ref(), key.as_deref()).map_err(|e| e.to_string())
        }
        other => Err(not_yet(other)),
    })
}

#[tauri::command]
pub fn ai_models(provider: Provider) -> Value {
    wrap(match provider {
        Provider::Claude => Ok(Vec::<String>::new()),
        other => Err(not_yet(other)),
    })
}

/// Sign-in flows for ChatGPT and Copilot arrive with those providers.
#[tauri::command]
pub fn ai_sign_in_unavailable(provider: Provider) -> Value {
    wrap::<()>(Err(not_yet(provider)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    req_id: u64,
    provider: Provider,
    #[allow(dead_code)]
    conv_id: Option<u64>,
    #[allow(dead_code)]
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
    if req.provider != Provider::Claude {
        return Ok(TurnResult::failed(err(
            ErrKind::Other,
            not_yet(req.provider),
        )));
    }
    let cancel = CancellationToken::new();
    app.ai_requests
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.req_id, cancel.clone());
    let client = claude::Claude::new(app.secrets.as_ref());
    let req_id = req.req_id;
    let result = client
        .turn(
            &req.messages,
            |text| {
                let _ = handle.emit(
                    "ai:delta",
                    Delta {
                        req_id,
                        text: text.to_owned(),
                    },
                );
            },
            &cancel,
        )
        .await;
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

/// Stateful providers (Copilot) hand tool calls back through these; Claude does not use them.
#[tauri::command]
pub fn ai_tool_result() {}

#[tauri::command]
pub fn ai_reset() {}

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
    #[allow(unused_variables)] model: Option<String>,
    diff: String,
) -> Result<MessageResult, ()> {
    if diff.trim().is_empty() || diff.encode_utf16().count() > 150_000 {
        return Ok(MessageResult::failed(err(
            ErrKind::Other,
            "Invalid staged diff or AI provider.",
        )));
    }
    if provider != Provider::Claude {
        return Ok(MessageResult::failed(err(
            ErrKind::Other,
            not_yet(provider),
        )));
    }
    let client = claude::Claude::new(app.secrets.as_ref());
    Ok(client
        .commit_message(&diff, &deadline(Duration::from_secs(180)))
        .await)
}

#[tauri::command]
pub async fn ai_resolve_conflict(
    app: tauri::State<'_, AppState>,
    provider: Provider,
    #[allow(unused_variables)] model: Option<String>,
    prompt: String,
    count: usize,
) -> Result<ResolveResult, ()> {
    if provider != Provider::Claude {
        return Ok(ResolveResult::failed(err(
            ErrKind::Other,
            not_yet(provider),
        )));
    }
    let client = claude::Claude::new(app.secrets.as_ref());
    Ok(client
        .resolve(&prompt, &deadline(Duration::from_secs(4 * 60)))
        .await
        .sanitized(count))
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
