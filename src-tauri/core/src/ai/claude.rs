//! Claude via the Anthropic Messages API (port of electron/ai/claude.ts). Uses the user's own API
//! key from the keychain, or ANTHROPIC_API_KEY.
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::sse::SseParser;
use super::{
    err, spec, AiErr, ErrKind, MessageResult, NMsg, Resolution, ResolveResult, Stop, ToolCall,
    TurnResult,
};
use crate::secrets::SecretStore;

pub const KEY: &str = "ai.apiKey";
/// Retry declined requests server-side on the model Anthropic recommends for that refusal category.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub model: String,
    pub stored_key: bool,
    pub env_key: bool,
    pub can_encrypt: bool,
}

pub fn status(secrets: &dyn SecretStore) -> ClaudeStatus {
    ClaudeStatus {
        model: spec().model.clone(),
        stored_key: secrets.get(KEY).is_some(),
        env_key: std::env::var_os("ANTHROPIC_API_KEY").is_some_and(|v| !v.is_empty()),
        can_encrypt: secrets.available(),
    }
}

pub fn set_key(secrets: &dyn SecretStore, key: Option<&str>) -> crate::Result<()> {
    secrets.set(KEY, key.map(str::trim).filter(|k| !k.is_empty()))
}

pub struct Claude {
    http: reqwest::Client,
    base: String,
    key: Option<String>,
}

enum Failure {
    Aborted,
    Err(AiErr),
    /// A streamed tool input did not parse; the TS version re-issues the turn (twice at most).
    BadToolInput,
}

impl Claude {
    pub fn new(secrets: &dyn SecretStore) -> Self {
        let key = secrets
            .get(KEY)
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
            .filter(|k| !k.is_empty());
        let base = std::env::var("GITVERSE_ANTHROPIC_BASE")
            .unwrap_or_else(|_| "https://api.anthropic.com".into());
        Self::with(base, key)
    }

    pub fn with(base: impl Into<String>, key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base: base.into().trim_end_matches('/').to_owned(),
            key,
        }
    }

    fn no_key() -> AiErr {
        err(ErrKind::Auth, "No Anthropic credentials found. Add an API key in Preferences → AI Assistant (or set ANTHROPIC_API_KEY).")
    }

    /// POST with the SDK's retry policy (2 retries on connection errors, 408, 409, 429 and 5xx).
    async fn post(
        &self,
        beta: bool,
        body: &Value,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response, Failure> {
        let key = self
            .key
            .as_deref()
            .ok_or_else(|| Failure::Err(Self::no_key()))?;
        let url = format!(
            "{}/v1/messages{}",
            self.base,
            if beta { "?beta=true" } else { "" }
        );
        for attempt in 0..3u32 {
            let mut req = self
                .http
                .post(&url)
                .header("x-api-key", key)
                .header("anthropic-version", VERSION)
                .json(body);
            if beta {
                req = req.header("anthropic-beta", FALLBACK_BETA);
            }
            let sent = tokio::select! {
                r = req.send() => r,
                _ = cancel.cancelled() => return Err(Failure::Aborted),
            };
            let retryable = match &sent {
                Ok(r) => {
                    matches!(r.status().as_u16(), 408 | 409 | 429) || r.status().is_server_error()
                }
                Err(e) => e.is_connect() || e.is_timeout(),
            };
            if retryable && attempt < 2 {
                let wait = Duration::from_millis(500 * 2u64.pow(attempt));
                tokio::select! {
                    _ = tokio::time::sleep(wait) => continue,
                    _ = cancel.cancelled() => return Err(Failure::Aborted),
                }
            }
            return match sent {
                Ok(r) if r.status().is_success() => Ok(r),
                Ok(r) => Err(Failure::Err(api_error(r).await)),
                Err(_) => Err(Failure::Err(err(
                    ErrKind::Network,
                    "Could not reach the Anthropic API. Check your internet connection.",
                ))),
            };
        }
        unreachable!("the loop returns on the last attempt")
    }

    /// One assistant turn, streamed: text deltas go to `on_text` as they arrive.
    pub async fn turn(
        &self,
        msgs: &[NMsg],
        on_text: impl Fn(&str),
        cancel: &CancellationToken,
    ) -> TurnResult {
        let s = spec();
        let body = json!({
            "model": s.model,
            "max_tokens": 64000,
            "system": s.system,
            "tools": s.tools,
            "messages": to_anthropic(msgs),
            "output_config": { "effort": "medium" },
            "fallbacks": "default",
            "stream": true,
        });
        for attempt in 0.. {
            match self.stream_turn(&body, &on_text, cancel).await {
                Ok(result) => return result,
                Err(Failure::Aborted) => return TurnResult::aborted(),
                Err(Failure::BadToolInput) if attempt < 2 => continue,
                Err(Failure::BadToolInput) => {
                    return TurnResult::failed(err(
                        ErrKind::Other,
                        "Claude returned a tool call that could not be read.",
                    ))
                }
                Err(Failure::Err(e)) => return TurnResult::failed(e),
            }
        }
        unreachable!()
    }

    async fn stream_turn(
        &self,
        body: &Value,
        on_text: &impl Fn(&str),
        cancel: &CancellationToken,
    ) -> Result<TurnResult, Failure> {
        let resp = self.post(true, body, cancel).await?;
        let mut stream = resp.bytes_stream();
        let mut sse = SseParser::default();
        let mut message = Message::default();
        loop {
            let chunk = tokio::select! {
                c = stream.next() => c,
                _ = cancel.cancelled() => return Err(Failure::Aborted),
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(|_| {
                Failure::Err(err(
                    ErrKind::Network,
                    "Could not reach the Anthropic API. Check your internet connection.",
                ))
            })?;
            for (event, data) in sse.push(&chunk) {
                if message.apply(&event, &data, on_text)? {
                    return Ok(message.finish());
                }
            }
        }
        Ok(message.finish())
    }

    pub async fn commit_message(&self, diff: &str, cancel: &CancellationToken) -> MessageResult {
        self.message(&spec().commit_system, diff, 1024, cancel)
            .await
    }

    /// One-shot text answer for `prompt` under `system` (commit messages, pull requests).
    pub async fn message(
        &self,
        system: &str,
        prompt: &str,
        max_tokens: u32,
        cancel: &CancellationToken,
    ) -> MessageResult {
        let body = json!({
            "model": spec().model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }],
        });
        let value = match self.post_json(false, &body, cancel).await {
            Ok(v) => v,
            Err(Failure::Aborted) => {
                return MessageResult::failed(err(ErrKind::Other, "The request was cancelled."))
            }
            Err(Failure::Err(e)) => return MessageResult::failed(e),
            Err(Failure::BadToolInput) => unreachable!(),
        };
        let text = text_of(&value).trim().to_owned();
        if text.is_empty() {
            MessageResult::failed(err(ErrKind::Other, "Claude returned no text."))
        } else {
            MessageResult::ok(text)
        }
    }

    pub async fn resolve(&self, prompt: &str, cancel: &CancellationToken) -> ResolveResult {
        let body = json!({
            "model": spec().model,
            "max_tokens": 16000,
            "system": spec().conflict_system,
            "messages": [{ "role": "user", "content": prompt }],
            "output_config": { "effort": "medium", "format": spec().conflict_format },
            "fallbacks": "default",
        });
        let value = match self.post_json(true, &body, cancel).await {
            Ok(v) => v,
            Err(Failure::Aborted) => {
                return ResolveResult::failed(err(ErrKind::Other, "The request was cancelled."))
            }
            Err(Failure::Err(e)) => return ResolveResult::failed(e),
            Err(Failure::BadToolInput) => unreachable!(),
        };
        match value["stop_reason"].as_str() {
            Some("refusal") => {
                return ResolveResult::failed(err(
                    ErrKind::Refusal,
                    "Claude declined to resolve this file.",
                ))
            }
            Some("max_tokens") => return ResolveResult::failed(err(
                ErrKind::Other,
                "The file is too large to resolve in one go. Resolve some conflicts by hand first.",
            )),
            _ => {}
        }
        #[derive(serde::Deserialize)]
        struct Parsed {
            resolutions: Vec<Resolution>,
        }
        match serde_json::from_str::<Parsed>(&text_of(&value)) {
            Ok(p) => ResolveResult::Ok {
                ok: true,
                resolutions: p.resolutions,
            },
            Err(_) => ResolveResult::failed(err(
                ErrKind::Other,
                "Claude did not return a usable result. Try again.",
            )),
        }
    }

    async fn post_json(
        &self,
        beta: bool,
        body: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Failure> {
        let resp = self.post(beta, body, cancel).await?;
        tokio::select! {
            v = resp.json::<Value>() => v.map_err(|_| Failure::Err(err(ErrKind::Network, "Could not reach the Anthropic API. Check your internet connection."))),
            _ = cancel.cancelled() => Err(Failure::Aborted),
        }
    }
}

/// The text blocks of a response, joined like the TS version.
fn text_of(message: &Value) -> String {
    message["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Map an HTTP error to the same user-facing messages as `describe()` in claude.ts.
async fn api_error(resp: reqwest::Response) -> AiErr {
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let detail = body["error"]["message"].as_str().unwrap_or("").to_owned();
    match status {
        401 | 403 => err(ErrKind::Auth, "Claude rejected the credentials. Add a valid Anthropic API key in Preferences → AI Assistant."),
        429 => err(ErrKind::Rate, "Rate limited by the Anthropic API — wait a moment and try again."),
        _ => err(ErrKind::Api, format!("Anthropic API error {status}: {detail}")),
    }
}

/// Neutral history → Anthropic messages. Claude's own earlier replies are replayed unchanged.
pub fn to_anthropic(msgs: &[NMsg]) -> Vec<Value> {
    msgs.iter()
        .map(|m| match m {
            NMsg::User { text } => json!({ "role": "user", "content": text }),
            NMsg::Assistant { text, calls, native, by } => {
                if let (Some(super::Provider::Claude), Some(native)) = (by, native) {
                    return json!({ "role": "assistant", "content": native });
                }
                let mut blocks = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for c in calls {
                    blocks.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.input }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "(no reply)" }));
                }
                json!({ "role": "assistant", "content": blocks })
            }
            NMsg::Tool { results } => json!({
                "role": "user",
                "content": results.iter().map(|r| {
                    let mut b = json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.text });
                    if r.is_error { b["is_error"] = json!(true); }
                    b
                }).collect::<Vec<_>>(),
            }),
        })
        .collect()
}

/// Accumulates a streamed message the way the SDK's `finalMessage()` does.
#[derive(Default)]
struct Message {
    model: Option<String>,
    blocks: Vec<Value>,
    partial_json: Vec<String>,
    stop_reason: Option<String>,
}

impl Message {
    /// Apply one SSE event. Returns true at `message_stop`.
    fn apply(&mut self, event: &str, data: &str, on_text: &impl Fn(&str)) -> Result<bool, Failure> {
        let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
        match event {
            "message_start" => {
                self.model = v["message"]["model"].as_str().map(str::to_owned);
            }
            "content_block_start" => {
                let i = v["index"].as_u64().unwrap_or(self.blocks.len() as u64) as usize;
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                self.blocks[i] = v["content_block"].clone();
            }
            "content_block_delta" => {
                let i = v["index"].as_u64().unwrap_or(0) as usize;
                let Some(block) = self.blocks.get_mut(i) else {
                    return Ok(false);
                };
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let t = d["text"].as_str().unwrap_or_default();
                        append(block, "text", t);
                        on_text(t);
                    }
                    Some("input_json_delta") => self.partial_json[i]
                        .push_str(d["partial_json"].as_str().unwrap_or_default()),
                    Some("thinking_delta") => append(
                        block,
                        "thinking",
                        d["thinking"].as_str().unwrap_or_default(),
                    ),
                    Some("signature_delta") => block["signature"] = d["signature"].clone(),
                    Some("citations_delta") => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(list) = block["citations"].as_array_mut() {
                            list.push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let i = v["index"].as_u64().unwrap_or(0) as usize;
                let raw = self.partial_json.get(i).cloned().unwrap_or_default();
                if let Some(block) = self.blocks.get_mut(i) {
                    if block["type"] == "tool_use" || block["type"] == "server_tool_use" {
                        block["input"] = if raw.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&raw).map_err(|_| Failure::BadToolInput)?
                        };
                    }
                }
            }
            "message_delta" => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(r.to_owned());
                }
            }
            "message_stop" => return Ok(true),
            "error" => {
                let kind = v["error"]["type"].as_str().unwrap_or("");
                let message = v["error"]["message"].as_str().unwrap_or("stream error");
                return Err(Failure::Err(match kind {
                    "rate_limit_error" | "overloaded_error" => err(
                        ErrKind::Rate,
                        "Rate limited by the Anthropic API — wait a moment and try again.",
                    ),
                    _ => err(ErrKind::Api, format!("Anthropic API error: {message}")),
                }));
            }
            _ => {}
        }
        Ok(false)
    }

    fn finish(self) -> TurnResult {
        let blocks: Vec<Value> = self.blocks.into_iter().filter(|b| !b.is_null()).collect();
        let text = blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let calls: Vec<ToolCall> = blocks
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .map(|b| ToolCall {
                id: b["id"].as_str().unwrap_or_default().to_owned(),
                name: b["name"].as_str().unwrap_or_default().to_owned(),
                input: if b["input"].is_object() {
                    b["input"].clone()
                } else {
                    Value::Object(Map::new())
                },
            })
            .collect();
        let stop = match self.stop_reason.as_deref() {
            Some("refusal") => Stop::Refusal,
            Some("max_tokens") => Stop::Max,
            _ if !calls.is_empty() => Stop::Tool,
            _ => Stop::End,
        };
        TurnResult::Done {
            ok: true,
            text,
            calls,
            native: Some(Value::Array(blocks)),
            stop,
            model: self.model,
        }
    }
}

fn append(block: &mut Value, field: &str, text: &str) {
    let current = block[field].as_str().unwrap_or_default().to_owned();
    block[field] = Value::String(current + text);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-shot HTTP server that records the request and replies with `response`.
    async fn mock(response: String) -> (String, Arc<Mutex<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let record = Arc::clone(&seen);
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1 << 20];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len: usize = text
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if req.len() >= h + 4 + len {
                        break;
                    }
                }
            }
            *record.lock().unwrap() = String::from_utf8_lossy(&req).to_string();
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
        });
        (format!("http://{addr}"), seen)
    }

    fn sse(events: &[(&str, Value)]) -> String {
        let body: String = events
            .iter()
            .map(|(e, d)| format!("event: {e}\ndata: {d}\n\n"))
            .collect();
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn streams_text_thinking_and_tool_calls() {
        let (base, seen) = mock(sse(&[
            ("message_start", json!({ "type": "message_start", "message": { "model": "claude-opus-5-5", "content": [] } })),
            ("content_block_start", json!({ "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } })),
            ("content_block_delta", json!({ "index": 0, "delta": { "type": "thinking_delta", "thinking": "Check status." } })),
            ("content_block_delta", json!({ "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } })),
            ("content_block_stop", json!({ "index": 0 })),
            ("content_block_start", json!({ "index": 1, "content_block": { "type": "text", "text": "" } })),
            ("content_block_delta", json!({ "index": 1, "delta": { "type": "text_delta", "text": "Let me " } })),
            ("content_block_delta", json!({ "index": 1, "delta": { "type": "text_delta", "text": "look." } })),
            ("content_block_stop", json!({ "index": 1 })),
            ("content_block_start", json!({ "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "get_repo_status", "input": {} } })),
            ("content_block_delta", json!({ "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"verbose\":" } })),
            ("content_block_delta", json!({ "index": 2, "delta": { "type": "input_json_delta", "partial_json": "true}" } })),
            ("content_block_stop", json!({ "index": 2 })),
            ("message_delta", json!({ "delta": { "stop_reason": "tool_use" } })),
            ("message_stop", json!({})),
        ]))
        .await;
        let deltas = Mutex::new(Vec::new());
        let claude = Claude::with(base, Some("sk-test".into()));
        let msgs = vec![NMsg::User {
            text: "status?".into(),
        }];
        let result = claude
            .turn(
                &msgs,
                |t| deltas.lock().unwrap().push(t.to_owned()),
                &CancellationToken::new(),
            )
            .await;

        let TurnResult::Done {
            text,
            calls,
            native,
            stop,
            model,
            ..
        } = result
        else {
            panic!("{result:?}")
        };
        assert_eq!(text, "Let me look.");
        assert_eq!(*deltas.lock().unwrap(), ["Let me ", "look."]);
        assert_eq!(
            calls,
            vec![ToolCall {
                id: "toolu_1".into(),
                name: "get_repo_status".into(),
                input: json!({ "verbose": true })
            }]
        );
        assert_eq!(stop, Stop::Tool);
        assert_eq!(model.as_deref(), Some("claude-opus-5-5"));
        let native = native.unwrap();
        assert_eq!(
            native[0],
            json!({ "type": "thinking", "thinking": "Check status.", "signature": "sig" })
        );

        let request = seen.lock().unwrap().clone();
        assert!(
            request.starts_with("POST /v1/messages?beta=true "),
            "{request}"
        );
        assert!(request.to_lowercase().contains("x-api-key: sk-test"));
        assert!(request
            .to_lowercase()
            .contains("anthropic-beta: server-side-fallback-2026-07-01"));
        let body: Value =
            serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], spec().model.as_str());
        assert_eq!(body["stream"], true);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["tools"], spec().tools);
    }

    #[tokio::test]
    async fn maps_auth_errors_like_the_ts_backend() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let (base, _) =
            mock(format!("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len()))
                .await;
        let result = Claude::with(base, Some("bad".into()))
            .turn(&[], |_| {}, &CancellationToken::new())
            .await;
        let TurnResult::Failed { error, .. } = result else {
            panic!("{result:?}")
        };
        assert_eq!(error.kind, ErrKind::Auth);
    }

    #[tokio::test]
    async fn without_a_key_reports_missing_credentials() {
        let result = Claude::with("http://127.0.0.1:9", None)
            .commit_message("diff", &CancellationToken::new())
            .await;
        let MessageResult::Failed { error, .. } = result else {
            panic!()
        };
        assert_eq!(error.kind, ErrKind::Auth);
        assert!(error.message.starts_with("No Anthropic credentials"));
    }

    #[tokio::test]
    async fn cancel_aborts_the_turn() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = Claude::with("http://127.0.0.1:9", Some("k".into()))
            .turn(&[], |_| {}, &cancel)
            .await;
        assert_eq!(result, TurnResult::aborted());
    }

    #[tokio::test]
    async fn resolves_conflicts_from_structured_output() {
        let reply = json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "{\"resolutions\":[{\"index\":0,\"resolved\":\"merged\",\"explanation\":\"kept both\"}]}" }]
        })
        .to_string();
        let (base, seen) =
            mock(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}", reply.len())).await;
        let result = Claude::with(base, Some("k".into()))
            .resolve("file", &CancellationToken::new())
            .await
            .sanitized(1);
        let ResolveResult::Ok { resolutions, .. } = result else {
            panic!("{result:?}")
        };
        assert_eq!(resolutions[0].resolved, "merged");
        let request = seen.lock().unwrap().clone();
        let body: Value =
            serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["output_config"]["format"], spec().conflict_format);
    }

    #[test]
    fn replays_claude_native_blocks_and_converts_others() {
        let native = json!([{ "type": "thinking", "thinking": "x", "signature": "s" }, { "type": "text", "text": "hi" }]);
        let msgs = vec![
            NMsg::Assistant {
                text: "hi".into(),
                calls: vec![],
                native: Some(native.clone()),
                by: Some(super::super::Provider::Claude),
            },
            NMsg::Assistant {
                text: String::new(),
                calls: vec![],
                native: Some(json!(["other"])),
                by: Some(super::super::Provider::Openai),
            },
            NMsg::Tool {
                results: vec![super::super::ToolResult {
                    id: "t".into(),
                    text: "bad".into(),
                    is_error: true,
                }],
            },
        ];
        let out = to_anthropic(&msgs);
        assert_eq!(out[0]["content"], native);
        assert_eq!(
            out[1]["content"],
            json!([{ "type": "text", "text": "(no reply)" }])
        );
        assert_eq!(out[2]["content"][0]["is_error"], true);
    }
}
