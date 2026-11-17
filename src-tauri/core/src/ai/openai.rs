//! ChatGPT via the user's own credentials (port of electron/ai/openai.ts):
//!  1. "Sign in with ChatGPT" (OAuth 2.0 + PKCE, loopback redirect) for the user's plan allowance.
//!  2. Or the user's own OpenAI API key (keychain, else OPENAI_API_KEY).
//!
//! Both call the Responses API with `store: false`. Base URLs can be overridden with
//! GITVERSE_OPENAI_BASE / GITVERSE_OPENAI_AUTH (used by the tests).
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::sse::SseParser;
use super::{
    err, spec, AiErr, ErrKind, MessageResult, NMsg, Resolution, ResolveResult, Stop, ToolCall,
    TurnResult,
};
use crate::secrets::SecretStore;

const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const RESOURCE: &str = "https://api.openai.com/v1";
pub const K_OAUTH: &str = "ai.openai.oauth";
pub const K_API_KEY: &str = "ai.openai.apiKey";
pub const K_HOST: &str = "ai.openai.hostId";
pub const K_CLIENT: &str = "ai.openai.clientId";
const NOT_SIGNED_IN: &str =
    "Not signed in to ChatGPT. Sign in (or add an OpenAI API key) in Preferences → AI Assistant.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Oauth {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// Unix milliseconds, like Date.now().
    expires_at: u64,
    #[serde(default)]
    scope: String,
    client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl Oauth {
    fn has_plan(&self) -> bool {
        self.scope.split_whitespace().any(|s| s == PLAN_SCOPE)
    }
    fn account(&self) -> String {
        self.email
            .clone()
            .or_else(|| self.name.clone())
            .or_else(|| self.sub.clone())
            .unwrap_or_else(|| "ChatGPT account".into())
    }
}

/// State shared by every request: the model list cache and the sign-in in progress.
#[derive(Default)]
pub struct Shared {
    models: Mutex<Option<(Instant, Vec<String>)>>,
    pending: Mutex<Option<CancellationToken>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiStatus {
    pub signed_in: bool,
    pub account: Option<String>,
    pub plan_usage: bool,
    pub has_api_key: bool,
    pub signing_in: bool,
    pub can_encrypt: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub account: String,
    pub plan_usage: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Plan,
    ApiKey,
}

enum Failure {
    Aborted,
    Err(AiErr),
}

struct Out {
    text: String,
    calls: Vec<ToolCall>,
    incomplete: Option<String>,
    model: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("OS random source");
    URL_SAFE_NO_PAD.encode(b)
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("OS random source");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// PKCE (S256): `(verifier, challenge)`.
pub fn pkce() -> (String, String) {
    let verifier = random_b64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// The JWT payload, unverified (provenance comes from TLS to the token endpoint).
pub fn jwt_claims(jwt: Option<&str>) -> Value {
    jwt.and_then(|j| j.split('.').nth(1))
        .and_then(|p| URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&p)
            .all(|(n, x)| x.len() == *n && x.chars().all(|c| c.is_ascii_hexdigit()))
        && p[2].starts_with('4')
        && p[3].starts_with(['8', '9', 'a', 'b', 'A', 'B'])
}

/// Same `{ok:false,error}` texts as mapHttp() in openai.ts.
fn map_http(status: u16, code: Option<&str>, message: &str, kind: Kind) -> AiErr {
    let code_s = code.unwrap_or("");
    if status == 401 {
        return err(
            ErrKind::Auth,
            if kind == Kind::Plan {
                "ChatGPT did not accept your sign-in. Sign in again in Preferences → AI Assistant."
            } else {
                "OpenAI rejected your API key. Check it in Preferences → AI Assistant."
            },
        );
    }
    let usage_hint = if code.is_some() { code_s } else { message };
    if code_s == "subscription_sharing_usage_limit_exceeded"
        || (status == 429 && kind == Kind::Plan && usage_hint.to_lowercase().contains("usage"))
    {
        return err(ErrKind::Usage, "The ChatGPT plan allowance for GITVerse is used up (an app limit may apply). Check ChatGPT settings → Usage, or use your own API key.");
    }
    if code_s == "subscription_sharing_user_not_eligible" {
        return err(
            ErrKind::Auth,
            "Your ChatGPT plan is not eligible to use this app.",
        );
    }
    match status {
        429 => err(
            ErrKind::Rate,
            "OpenAI rate limit reached — wait a moment and try again.",
        ),
        403 => err(
            ErrKind::Auth,
            format!("OpenAI refused the request: {message}"),
        ),
        503 if code_s == "subscription_sharing_usage_unavailable" => err(
            ErrKind::Api,
            "ChatGPT plan usage could not be checked right now. Try again later.",
        ),
        _ => err(ErrKind::Api, format!("OpenAI error {status}: {message}")),
    }
}

/// Neutral history → Responses API `input` items (no server ids: nothing is stored).
pub fn to_responses_input(msgs: &[NMsg]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in msgs {
        match m {
            NMsg::User { text } => out.push(json!({ "role": "user", "content": text })),
            NMsg::Assistant { text, calls, .. } => {
                if !text.is_empty() {
                    out.push(json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] }));
                }
                for c in calls {
                    out.push(json!({ "type": "function_call", "call_id": c.id, "name": c.name, "arguments": c.input.to_string() }));
                }
            }
            NMsg::Tool { results } => {
                for r in results {
                    let output = if r.is_error {
                        format!("Error: {}", r.text)
                    } else {
                        r.text.clone()
                    };
                    out.push(json!({ "type": "function_call_output", "call_id": r.id, "output": output }));
                }
            }
        }
    }
    out
}

fn tool_defs() -> Value {
    Value::Array(
        spec()
            .tools
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| json!({ "type": "function", "name": t["name"], "description": t["description"], "parameters": t["input_schema"] }))
            .collect(),
    )
}

/// The first `{…}` span, parsed as a conflict resolution (parseResolution in openai.ts).
pub fn parse_resolution(text: &str) -> ResolveResult {
    #[derive(Deserialize)]
    struct Parsed {
        resolutions: Vec<Resolution>,
    }
    let span = match (text.find('{'), text.rfind('}')) {
        (Some(a), Some(b)) if b > a => &text[a..=b],
        _ => text,
    };
    match serde_json::from_str::<Parsed>(span) {
        Ok(p) => ResolveResult::Ok {
            ok: true,
            resolutions: p.resolutions,
        },
        Err(_) => ResolveResult::failed(err(
            ErrKind::Other,
            "The AI did not return a usable result. Try again.",
        )),
    }
}

const PAGE_STYLE: &str = "font:16px system-ui;background:#1e1e2e;color:#cdd6f4;display:grid;place-items:center;height:100vh;margin:0";

fn page(title: &str, body: &str) -> String {
    format!("<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body style=\"{PAGE_STYLE}\"><div style=\"text-align:center\"><h2>{title}</h2><p>{body}</p></div>")
}

pub struct OpenAi {
    http: reqwest::Client,
    api_base: String,
    auth_base: String,
    secrets: Arc<dyn SecretStore>,
    shared: Arc<Shared>,
}

impl OpenAi {
    pub fn new(secrets: Arc<dyn SecretStore>, shared: Arc<Shared>) -> Self {
        Self::with(
            std::env::var("GITVERSE_OPENAI_BASE").unwrap_or_else(|_| RESOURCE.into()),
            std::env::var("GITVERSE_OPENAI_AUTH")
                .unwrap_or_else(|_| "https://auth.openai.com/api/accounts".into()),
            secrets,
            shared,
        )
    }

    pub fn with(
        api_base: impl Into<String>,
        auth_base: impl Into<String>,
        secrets: Arc<dyn SecretStore>,
        shared: Arc<Shared>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            http,
            api_base: api_base.into().trim_end_matches('/').to_owned(),
            auth_base: auth_base.into().trim_end_matches('/').to_owned(),
            secrets,
            shared,
        }
    }

    fn load_oauth(&self) -> Option<Oauth> {
        serde_json::from_str(&self.secrets.get(K_OAUTH)?).ok()
    }

    fn save_oauth(&self, o: Option<&Oauth>) -> crate::Result<()> {
        let json = o.map(|o| serde_json::to_string(o).unwrap_or_default());
        self.secrets.set(K_OAUTH, json.as_deref())
    }

    fn clear_models(&self) {
        *self.shared.models.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn status(&self) -> OpenAiStatus {
        let o = self.load_oauth();
        OpenAiStatus {
            signed_in: o.is_some(),
            account: o.as_ref().map(Oauth::account),
            plan_usage: o.as_ref().is_some_and(Oauth::has_plan),
            has_api_key: self.secrets.get(K_API_KEY).is_some(),
            signing_in: self
                .shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            can_encrypt: self.secrets.available(),
        }
    }

    pub fn set_key(&self, key: Option<&str>) -> crate::Result<()> {
        self.clear_models();
        self.secrets
            .set(K_API_KEY, key.map(str::trim).filter(|k| !k.is_empty()))
    }

    /// Keeps the issued client id: it is reused on the next sign-in.
    pub fn sign_out(&self) -> crate::Result<()> {
        self.clear_models();
        self.save_oauth(None)
    }

    pub fn cancel_sign_in(&self) {
        if let Some(c) = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            c.cancel();
        }
    }

    fn host_id(&self) -> String {
        let saved = self.secrets.get(K_HOST);
        let id = match &saved {
            Some(s) if is_uuid(s) => format!("urn:uuid:{s}"),
            Some(s) => s.clone(),
            None => format!("urn:uuid:{}", uuid_v4()),
        };
        if saved.as_deref() != Some(id.as_str()) {
            let _ = self.secrets.set(K_HOST, Some(&id));
        }
        id
    }

    /// Opens the browser (through `open_url`), waits for the loopback callback, exchanges the
    /// code and stores the tokens.
    pub async fn sign_in(&self, open_url: impl FnOnce(&str) + Send) -> Result<SignedIn, String> {
        let cancel = {
            let mut p = self
                .shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if p.is_some() {
                return Err("A ChatGPT sign-in is already in progress.".into());
            }
            let c = CancellationToken::new();
            *p = Some(c.clone());
            c
        };
        let r = self.sign_in_inner(open_url, &cancel).await;
        *self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        r
    }

    async fn sign_in_inner(
        &self,
        open_url: impl FnOnce(&str) + Send,
        cancel: &CancellationToken,
    ) -> Result<SignedIn, String> {
        let (verifier, challenge) = pkce();
        let state = random_b64(16);
        let nonce = random_b64(16);
        let saved = self.secrets.get(K_CLIENT);

        // 1455 first (the documented example); only the port may vary between sign-ins
        let mut listener = None;
        for p in [1455u16, 1456, 1457, 0] {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                listener = Some(l);
                break;
            }
        }
        let listener = listener.ok_or("Could not open a local port for the sign-in callback.")?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect = format!("http://127.0.0.1:{port}/auth/callback");

        let authorize_url = {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            q.append_pair(
                "client_id",
                saved.as_deref().unwrap_or("dynamic_agent_client"),
            )
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("ext_agent_host_id", &self.host_id());
            if saved.is_none() {
                q.append_pair("agent_name_hint", "GITVerse");
            }
            format!("{}/authorize?{}", self.auth_base, q.finish())
        };
        open_url(&authorize_url);

        let callback = tokio::select! {
            r = wait_callback(&listener, &state) => r?,
            _ = tokio::time::sleep(Duration::from_secs(5 * 60)) => return Err("Sign-in timed out after 5 minutes.".into()),
            _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
        };
        drop(listener);
        let (code, issued) = callback;
        let client_id = issued.clone().or(saved.clone());
        let client_id = match client_id {
            Some(c) if c != "dynamic_agent_client" => c,
            _ => return Err("OpenAI did not issue a client ID for this app, so ChatGPT plan sign-in is not available to it. Use your own OpenAI API key instead.".into()),
        };
        if let (Some(s), Some(i)) = (&saved, &issued) {
            if s != i {
                return Err(
                    "OpenAI returned a different client ID than the one saved for this sign-in."
                        .into(),
                );
            }
        }
        let tok = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("resource", RESOURCE),
            ])
            .await
            .map_err(|(m, _)| m)?;
        let id_token = tok["id_token"].as_str().map(str::to_owned);
        let claims = jwt_claims(id_token.as_deref());
        if let Some(n) = claims["nonce"].as_str() {
            if n != nonce {
                return Err("Sign-in response failed the nonce check.".into());
            }
        }
        let aud_ok = match &claims["aud"] {
            Value::Null => true,
            Value::String(a) => a == &client_id,
            Value::Array(a) => a.iter().any(|x| x.as_str() == Some(&client_id)),
            _ => false,
        };
        if !aud_ok {
            return Err("Sign-in response was issued for a different app.".into());
        }
        let o = Oauth {
            access_token: tok["access_token"].as_str().unwrap_or_default().to_owned(),
            refresh_token: tok["refresh_token"].as_str().map(str::to_owned),
            expires_at: now_ms() + tok["expires_in"].as_u64().unwrap_or(3600) * 1000,
            scope: tok["scope"].as_str().unwrap_or_default().to_owned(),
            client_id: client_id.clone(),
            id_token,
            sub: claims["sub"].as_str().map(str::to_owned),
            email: claims["email"].as_str().map(str::to_owned),
            name: claims["name"].as_str().map(str::to_owned),
        };
        self.secrets
            .set(K_CLIENT, Some(&client_id))
            .map_err(|e| e.to_string())?;
        self.save_oauth(Some(&o)).map_err(|e| e.to_string())?;
        self.clear_models();
        Ok(SignedIn {
            account: o.account(),
            plan_usage: o.has_plan(),
        })
    }

    /// Form POST to the token endpoint. Errors carry the OAuth `error` code.
    async fn token_request(
        &self,
        form: &[(&str, &str)],
    ) -> Result<Value, (String, Option<String>)> {
        let res = self
            .http
            .post(format!("{}/oauth/token", self.auth_base))
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| (format!("Could not reach OpenAI: {e}"), None))?;
        let status = res.status();
        let json: Value =
            serde_json::from_str(&res.text().await.unwrap_or_default()).unwrap_or(Value::Null);
        if !status.is_success() {
            let code = json["error"].as_str().map(str::to_owned);
            let msg = json["error_description"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| code.clone())
                .unwrap_or_else(|| format!("Token request failed ({})", status.as_u16()));
            return Err((msg, code));
        }
        Ok(json)
    }

    /// Rotating refresh. On `invalid_grant` the stored sign-in is dropped (Err(None) = re-auth).
    async fn refresh(&self, o: Oauth) -> Result<Oauth, Option<String>> {
        let Some(rt) = o.refresh_token.clone() else {
            return Err(None);
        };
        match self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", &o.client_id),
                ("refresh_token", &rt),
                ("resource", RESOURCE),
            ])
            .await
        {
            Ok(t) => {
                let next = Oauth {
                    access_token: t["access_token"].as_str().unwrap_or_default().to_owned(),
                    refresh_token: t["refresh_token"]
                        .as_str()
                        .map(str::to_owned)
                        .or(o.refresh_token),
                    expires_at: now_ms() + t["expires_in"].as_u64().unwrap_or(3600) * 1000,
                    scope: t["scope"].as_str().map(str::to_owned).unwrap_or(o.scope),
                    id_token: t["id_token"].as_str().map(str::to_owned).or(o.id_token),
                    ..o
                };
                let _ = self.save_oauth(Some(&next));
                Ok(next)
            }
            Err((_, Some(code))) if code == "invalid_grant" => {
                let _ = self.save_oauth(None);
                Err(None)
            }
            Err((m, _)) => Err(Some(m)),
        }
    }

    /// ChatGPT plan sign-in if it grants plan usage, else the user's own API key.
    /// Err(None) = no credentials (sign in); Err(Some) = network trouble.
    async fn credential(&self, force_refresh: bool) -> Result<(String, Kind), Option<String>> {
        if let Some(mut o) = self.load_oauth().filter(Oauth::has_plan) {
            if force_refresh || o.expires_at < now_ms() + 60_000 {
                o = self.refresh(o).await?;
            }
            return Ok((o.access_token, Kind::Plan));
        }
        self.secrets
            .get(K_API_KEY)
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .filter(|k| !k.is_empty())
            .map(|k| (k, Kind::ApiKey))
            .ok_or(None)
    }

    pub async fn models(&self) -> Result<Vec<String>, String> {
        if let Some((at, list)) = &*self.shared.models.lock().unwrap_or_else(|e| e.into_inner()) {
            if at.elapsed() < Duration::from_secs(600) {
                return Ok(list.clone());
            }
        }
        let (token, kind) = self
            .credential(false)
            .await
            .map_err(|e| e.unwrap_or_else(|| "No ChatGPT credentials".into()))?;
        let res = self
            .http
            .get(format!("{}/models", self.api_base))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Could not list models ({})", res.status().as_u16()));
        }
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        let items = json["data"]
            .as_array()
            .or_else(|| json["models"].as_array())
            .cloned()
            .unwrap_or_default();
        let mut list: Vec<String> = items
            .iter()
            .filter(|m| m.get("visibility").is_none() || m["visibility"] == "list")
            .filter_map(|m| {
                m["slug"]
                    .as_str()
                    .or_else(|| m["id"].as_str())
                    .map(str::to_owned)
            })
            .filter(|id| kind == Kind::Plan || is_api_chat_model(id))
            .collect();
        list.sort();
        list.dedup();
        *self.shared.models.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((Instant::now(), list.clone()));
        Ok(list)
    }

    #[allow(clippy::too_many_arguments)]
    async fn respond(
        &self,
        input: Vec<Value>,
        instructions: &str,
        model: Option<String>,
        tools: bool,
        text_format: Option<Value>,
        on_text: &(dyn Fn(&str) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<Out, Failure> {
        let model = match model.filter(|m| !m.is_empty()) {
            Some(m) => m,
            None => {
                let first = tokio::select! {
                    r = self.models() => r,
                    _ = cancel.cancelled() => return Err(Failure::Aborted),
                };
                match first {
                    Ok(list) => list.into_iter().next().ok_or_else(|| Failure::Err(err(ErrKind::Other, "No ChatGPT model is available for this account. Pick one in Preferences → AI Assistant.")))?,
                    Err(e) if e == "No ChatGPT credentials" => return Err(Failure::Err(err(ErrKind::Auth, NOT_SIGNED_IN))),
                    Err(e) => return Err(Failure::Err(err(ErrKind::Network, format!("Could not reach OpenAI: {e}")))),
                }
            }
        };
        let mut body = json!({
            "model": model, "instructions": instructions, "input": input,
            "stream": true, "store": false,
        });
        if tools {
            body["tools"] = tool_defs();
        }
        if let Some(f) = text_format {
            body["text"] = json!({ "format": f });
        }

        let mut refreshed = false;
        let mut attempt = 0u32;
        loop {
            let (token, kind) = self
                .credential(false)
                .await
                .map_err(|_| Failure::Err(err(ErrKind::Auth, NOT_SIGNED_IN)))?;
            let send = self
                .http
                .post(format!("{}/responses", self.api_base))
                .bearer_auth(&token)
                .header("accept", "text/event-stream")
                .json(&body)
                .send();
            let res = tokio::select! {
                r = send => r.map_err(|e| Failure::Err(err(ErrKind::Network, format!("Could not reach OpenAI: {e}"))))?,
                _ = cancel.cancelled() => return Err(Failure::Aborted),
            };
            let status = res.status().as_u16();
            if !res.status().is_success() {
                let reason = res.status().canonical_reason().unwrap_or("").to_owned();
                let j: Value = res.json().await.unwrap_or(Value::Null);
                let code = j["error"]["code"]
                    .as_str()
                    .or_else(|| j["code"].as_str())
                    .map(str::to_owned);
                let message = j["error"]["message"]
                    .as_str()
                    .or_else(|| j["message"].as_str())
                    .map(str::to_owned)
                    .unwrap_or(reason);
                if status == 401 && kind == Kind::Plan && !refreshed {
                    refreshed = true;
                    if self.credential(true).await.is_ok() {
                        continue;
                    }
                }
                if status == 503
                    && code.as_deref() == Some("subscription_sharing_usage_unavailable")
                    && attempt < 2
                {
                    let wait = Duration::from_millis(1000 * 2u64.pow(attempt));
                    attempt += 1;
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => continue,
                        _ = cancel.cancelled() => return Err(Failure::Aborted),
                    }
                }
                return Err(Failure::Err(map_http(
                    status,
                    code.as_deref(),
                    &message,
                    kind,
                )));
            }

            let mut out = Out {
                text: String::new(),
                calls: Vec::new(),
                incomplete: None,
                model: model.clone(),
            };
            let mut completed = false;
            let mut stream = res.bytes_stream();
            let mut sse = SseParser::default();
            loop {
                let chunk = tokio::select! {
                    c = stream.next() => c,
                    _ = cancel.cancelled() => return Err(Failure::Aborted),
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| {
                    Failure::Err(err(
                        ErrKind::Network,
                        format!("The connection to OpenAI was interrupted: {e}"),
                    ))
                })?;
                for (_, data) in sse.push(&chunk) {
                    if data == "[DONE]" {
                        continue;
                    }
                    let Ok(ev) = serde_json::from_str::<Value>(&data) else {
                        continue;
                    };
                    match ev["type"].as_str().unwrap_or("") {
                        "response.output_text.delta" => {
                            if let Some(d) = ev["delta"].as_str() {
                                out.text.push_str(d);
                                on_text(d);
                            }
                        }
                        "response.output_item.done" if ev["item"]["type"] == "function_call" => {
                            let item = &ev["item"];
                            let args = item["arguments"].as_str().unwrap_or("");
                            let input =
                                serde_json::from_str(if args.is_empty() { "{}" } else { args })
                                    .unwrap_or_else(|_| json!({ "__invalid": args }));
                            out.calls.push(ToolCall {
                                id: item["call_id"].as_str().unwrap_or_default().to_owned(),
                                name: item["name"].as_str().unwrap_or_default().to_owned(),
                                input,
                            });
                        }
                        "response.completed" => completed = true,
                        "response.incomplete" => {
                            completed = true;
                            out.incomplete = Some(
                                ev["response"]["incomplete_details"]["reason"]
                                    .as_str()
                                    .unwrap_or("incomplete")
                                    .to_owned(),
                            );
                        }
                        "response.failed" | "error" => {
                            let e = if ev["response"]["error"].is_object() {
                                &ev["response"]["error"]
                            } else {
                                &ev
                            };
                            let code = e["code"].as_str();
                            let st = if code == Some("subscription_sharing_usage_limit_exceeded") {
                                429
                            } else {
                                500
                            };
                            return Err(Failure::Err(map_http(
                                st,
                                code,
                                e["message"].as_str().unwrap_or("The response failed."),
                                kind,
                            )));
                        }
                        _ => {}
                    }
                }
            }
            if !completed {
                return Err(Failure::Err(err(
                    ErrKind::Network,
                    "The response ended before it was complete. Try again.",
                )));
            }
            return Ok(out);
        }
    }

    pub async fn turn(
        &self,
        msgs: &[NMsg],
        model: Option<String>,
        on_text: &(dyn Fn(&str) + Send + Sync),
        cancel: &CancellationToken,
    ) -> TurnResult {
        let r = self
            .respond(
                to_responses_input(msgs),
                &spec().system,
                model,
                true,
                None,
                on_text,
                cancel,
            )
            .await;
        match r {
            Err(Failure::Aborted) => TurnResult::aborted(),
            Err(Failure::Err(e)) => TurnResult::failed(e),
            Ok(out) => {
                let stop = match out.incomplete.as_deref() {
                    Some("max_output_tokens") => Stop::Max,
                    Some("content_filter") => Stop::Refusal,
                    _ if !out.calls.is_empty() => Stop::Tool,
                    _ => Stop::End,
                };
                TurnResult::Done {
                    ok: true,
                    text: out.text,
                    calls: out.calls,
                    native: None,
                    stop,
                    model: Some(out.model),
                }
            }
        }
    }

    pub async fn resolve(
        &self,
        prompt: &str,
        model: Option<String>,
        cancel: &CancellationToken,
    ) -> ResolveResult {
        let mut schema = spec().conflict_format["schema"].clone();
        if let Some(o) = schema.as_object_mut() {
            o.remove("$schema");
        }
        let format = json!({ "type": "json_schema", "name": "conflict_resolution", "schema": schema, "strict": true });
        let input = vec![json!({ "role": "user", "content": prompt })];
        match self
            .respond(
                input,
                &spec().conflict_system,
                model,
                false,
                Some(format),
                &|_| {},
                cancel,
            )
            .await
        {
            Err(Failure::Aborted) => ResolveResult::failed(err(ErrKind::Other, "Cancelled.")),
            Err(Failure::Err(e)) => ResolveResult::failed(e),
            Ok(out) if out.incomplete.is_some() => ResolveResult::failed(err(
                ErrKind::Other,
                "The file is too large to resolve in one go. Resolve some conflicts by hand first.",
            )),
            Ok(out) => parse_resolution(&out.text),
        }
    }

    pub async fn commit_message(
        &self,
        diff: &str,
        model: Option<String>,
        cancel: &CancellationToken,
    ) -> MessageResult {
        let input = vec![json!({ "role": "user", "content": diff })];
        match self
            .respond(
                input,
                &spec().commit_system,
                model,
                false,
                None,
                &|_| {},
                cancel,
            )
            .await
        {
            Err(Failure::Aborted) => MessageResult::failed(err(ErrKind::Other, "Cancelled.")),
            Err(Failure::Err(e)) => MessageResult::failed(e),
            Ok(out) if out.incomplete.is_some() || out.text.trim().is_empty() => {
                MessageResult::failed(err(
                    ErrKind::Other,
                    "AI did not return a complete commit message.",
                ))
            }
            Ok(out) => MessageResult::ok(out.text.trim().to_owned()),
        }
    }
}

/// `/^(gpt|o\d|chatgpt)/` from openai.ts.
fn is_api_chat_model(id: &str) -> bool {
    id.starts_with("gpt")
        || id.starts_with("chatgpt")
        || (id.starts_with('o') && id[1..].starts_with(|c: char| c.is_ascii_digit()))
}

/// Serve the loopback redirect until a callback for this sign-in arrives: `(code, client_id)`.
async fn wait_callback(
    listener: &tokio::net::TcpListener,
    state: &str,
) -> Result<(String, Option<String>), String> {
    loop {
        let Ok((mut sock, _)) = listener.accept().await else {
            continue;
        };
        let mut buf = vec![0u8; 16 * 1024];
        let mut req = Vec::new();
        while !req.windows(4).any(|w| w == b"\r\n\r\n") && req.len() < buf.len() {
            match sock.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => req.extend_from_slice(&buf[..n]),
            }
        }
        let head = String::from_utf8_lossy(&req);
        let target = head.split_whitespace().nth(1).unwrap_or("/");
        let Ok(u) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
            continue;
        };
        if u.path() != "/auth/callback" {
            let _ = sock
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let get = |k: &str| {
            u.query_pairs()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.into_owned())
        };
        let (status, title, body, result) = if get("state").as_deref() != Some(state) {
            (
                400,
                "Sign-in failed",
                "The response did not match this sign-in attempt. Close this tab and try again."
                    .to_owned(),
                Err("Sign-in response had the wrong state.".to_owned()),
            )
        } else if let Some(e) = get("error") {
            let denied = e == "access_denied";
            (
                200,
                "Sign-in cancelled",
                if denied {
                    "You declined access. You can close this tab.".to_owned()
                } else {
                    format!("OpenAI returned: {}", html_escape(&e))
                },
                Err(if denied {
                    "Sign-in was cancelled.".to_owned()
                } else {
                    format!("OpenAI returned an error: {e}")
                }),
            )
        } else if let Some(code) = get("code") {
            (
                200,
                "Signed in to GITVerse",
                "You can close this tab and return to the app.".to_owned(),
                Ok((code, get("client_id"))),
            )
        } else {
            (
                400,
                "Sign-in failed",
                "No authorization code was returned.".to_owned(),
                Err("No authorization code was returned.".to_owned()),
            )
        };
        let html = page(title, &body);
        let reason = if status == 200 { "OK" } else { "Bad Request" };
        let _ = sock
            .write_all(
                format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{html}",
                    html.len()
                )
                .as_bytes(),
            )
            .await;
        let _ = sock.shutdown().await;
        return result;
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;
    use std::sync::Mutex as StdMutex;

    type Seen = Arc<StdMutex<Vec<String>>>;

    /// Serves `responses` in order, one connection each, recording every request.
    async fn mock(responses: Vec<String>) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let record = Arc::clone(&seen);
        tokio::spawn(async move {
            for response in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 1 << 20];
                let mut req = Vec::new();
                loop {
                    let n = sock.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
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
                record
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&req).to_string());
                sock.write_all(response.as_bytes()).await.unwrap();
                sock.shutdown().await.ok();
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn http(status: &str, ctype: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn sse(events: &[Value]) -> String {
        let body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
        http("200 OK", "text/event-stream", &body)
    }

    fn body_of(req: &str) -> Value {
        serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap()
    }

    fn client(base: &str, store: Arc<MemoryStore>) -> OpenAi {
        OpenAi::with(base, format!("{base}/auth"), store, Arc::default())
    }

    fn plan_oauth(expires_at: u64) -> String {
        json!({ "accessToken": "old", "refreshToken": "r1", "expiresAt": expires_at, "scope": format!("openid {PLAN_SCOPE}"), "clientId": "app_1", "email": "a@b.c" }).to_string()
    }

    #[tokio::test]
    async fn streams_a_turn_with_text_and_a_function_call() {
        let (base, seen) = mock(vec![sse(&[
            json!({ "type": "response.output_text.delta", "delta": "Let me " }),
            json!({ "type": "response.output_text.delta", "delta": "look." }),
            json!({ "type": "response.output_item.done", "item": { "type": "function_call", "call_id": "c1", "name": "get_repo_status", "arguments": "{\"verbose\":true}" } }),
            json!({ "type": "response.completed", "response": {} }),
        ])])
        .await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_API_KEY, Some("sk-test")).unwrap();
        let deltas = StdMutex::new(Vec::<String>::new());
        let r = client(&base, store)
            .turn(
                &[NMsg::User { text: "hi".into() }],
                Some("gpt-5".into()),
                &|t| deltas.lock().unwrap().push(t.to_owned()),
                &CancellationToken::new(),
            )
            .await;
        let TurnResult::Done {
            text,
            calls,
            stop,
            model,
            ..
        } = r
        else {
            panic!("{r:?}")
        };
        assert_eq!(text, "Let me look.");
        assert_eq!(*deltas.lock().unwrap(), ["Let me ", "look."]);
        assert_eq!(calls[0].input, json!({ "verbose": true }));
        assert_eq!(stop, Stop::Tool);
        assert_eq!(model.as_deref(), Some("gpt-5"));
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /responses "), "{req}");
        assert!(req.to_lowercase().contains("authorization: bearer sk-test"));
        let body = body_of(&req);
        assert_eq!(body["store"], false);
        assert_eq!(body["instructions"], spec().system.as_str());
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(
            body["tools"][0]["parameters"],
            spec().tools[0]["input_schema"]
        );
    }

    #[tokio::test]
    async fn refreshes_an_expired_plan_token_and_lists_models() {
        let token = json!({ "access_token": "new", "refresh_token": "r2", "expires_in": 3600, "scope": format!("openid {PLAN_SCOPE}") }).to_string();
        let models = json!({ "models": [{ "slug": "gpt-5", "visibility": "list" }, { "slug": "hidden", "visibility": "hide" }, { "slug": "codex-x" }] }).to_string();
        let (base, seen) = mock(vec![
            http("200 OK", "application/json", &token),
            http("200 OK", "application/json", &models),
        ])
        .await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_OAUTH, Some(&plan_oauth(0))).unwrap();
        let ai = client(&base, Arc::clone(&store));
        assert_eq!(ai.models().await.unwrap(), ["codex-x", "gpt-5"]);
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /auth/oauth/token "));
        assert!(reqs[0].contains("grant_type=refresh_token"));
        assert!(reqs[1].to_lowercase().contains("authorization: bearer new"));
        let saved: Value = serde_json::from_str(&store.get(K_OAUTH).unwrap()).unwrap();
        assert_eq!(saved["refreshToken"], "r2");
        assert!(ai.status().plan_usage);
        // cached for 10 minutes: no further request
        assert_eq!(ai.models().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn invalid_grant_drops_the_sign_in() {
        let (base, _) = mock(vec![http(
            "400 Bad Request",
            "application/json",
            r#"{"error":"invalid_grant"}"#,
        )])
        .await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_OAUTH, Some(&plan_oauth(0))).unwrap();
        let r = client(&base, Arc::clone(&store))
            .commit_message("diff", Some("gpt-5".into()), &CancellationToken::new())
            .await;
        let MessageResult::Failed { error, .. } = r else {
            panic!()
        };
        assert_eq!(error.kind, ErrKind::Auth);
        assert!(store.get(K_OAUTH).is_none());
    }

    #[tokio::test]
    async fn api_keys_only_see_chat_models() {
        let models = json!({ "data": [{ "id": "gpt-5" }, { "id": "o3" }, { "id": "whisper-1" }, { "id": "omni-x" }] }).to_string();
        let (base, _) = mock(vec![http("200 OK", "application/json", &models)]).await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_API_KEY, Some("k")).unwrap();
        assert_eq!(
            client(&base, store).models().await.unwrap(),
            ["gpt-5", "o3"]
        );
    }

    #[test]
    fn maps_errors_like_the_ts_backend() {
        assert_eq!(map_http(401, None, "", Kind::ApiKey).kind, ErrKind::Auth);
        assert_eq!(
            map_http(429, Some("usage_limit"), "", Kind::Plan).kind,
            ErrKind::Usage
        );
        assert_eq!(
            map_http(429, None, "slow down", Kind::ApiKey).kind,
            ErrKind::Rate
        );
        assert_eq!(
            map_http(500, None, "boom", Kind::ApiKey).message,
            "OpenAI error 500: boom"
        );
    }

    #[tokio::test]
    async fn resolves_with_a_strict_json_schema() {
        let text =
            "{\"resolutions\":[{\"index\":0,\"resolved\":\"merged\",\"explanation\":\"both\"}]}";
        let (base, seen) = mock(vec![sse(&[
            json!({ "type": "response.output_text.delta", "delta": text }),
            json!({ "type": "response.completed" }),
        ])])
        .await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_API_KEY, Some("k")).unwrap();
        let r = client(&base, store)
            .resolve("file", Some("gpt-5".into()), &CancellationToken::new())
            .await;
        let ResolveResult::Ok { resolutions, .. } = r else {
            panic!("{r:?}")
        };
        assert_eq!(resolutions[0].resolved, "merged");
        let body = body_of(&seen.lock().unwrap()[0]);
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert!(body["text"]["format"]["schema"].get("$schema").is_none());
    }

    #[tokio::test]
    async fn truncated_stream_is_an_error() {
        let (base, _) = mock(vec![sse(&[
            json!({ "type": "response.output_text.delta", "delta": "x" }),
        ])])
        .await;
        let store = Arc::new(MemoryStore::default());
        store.set(K_API_KEY, Some("k")).unwrap();
        let r = client(&base, store)
            .turn(
                &[],
                Some("gpt-5".into()),
                &|_| {},
                &CancellationToken::new(),
            )
            .await;
        let TurnResult::Failed { error, .. } = r else {
            panic!("{r:?}")
        };
        assert_eq!(error.kind, ErrKind::Network);
    }

    #[tokio::test]
    async fn without_credentials_asks_to_sign_in() {
        let r = client("http://127.0.0.1:9", Arc::default())
            .turn(
                &[],
                Some("gpt-5".into()),
                &|_| {},
                &CancellationToken::new(),
            )
            .await;
        let TurnResult::Failed { error, .. } = r else {
            panic!()
        };
        assert_eq!(error.message, NOT_SIGNED_IN);
    }

    #[test]
    fn converts_history_to_responses_items() {
        let msgs = vec![
            NMsg::User { text: "hi".into() },
            NMsg::Assistant {
                text: "ok".into(),
                calls: vec![ToolCall {
                    id: "c".into(),
                    name: "f".into(),
                    input: json!({ "a": 1 }),
                }],
                native: None,
                by: None,
            },
            NMsg::Tool {
                results: vec![super::super::ToolResult {
                    id: "c".into(),
                    text: "bad".into(),
                    is_error: true,
                }],
            },
        ];
        let out = to_responses_input(&msgs);
        assert_eq!(out[1]["content"][0]["type"], "output_text");
        assert_eq!(
            out[2],
            json!({ "type": "function_call", "call_id": "c", "name": "f", "arguments": "{\"a\":1}" })
        );
        assert_eq!(out[3]["output"], "Error: bad");
    }

    #[test]
    fn pkce_and_jwt_helpers() {
        let (v, c) = pkce();
        assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
        let jwt = format!(
            "h.{}.s",
            URL_SAFE_NO_PAD.encode(br#"{"sub":"u1","aud":["x"]}"#)
        );
        assert_eq!(jwt_claims(Some(&jwt))["sub"], "u1");
        assert!(is_uuid(&uuid_v4()));
        assert_eq!(
            parse_resolution("noise {\"resolutions\":[]} tail"),
            ResolveResult::Ok {
                ok: true,
                resolutions: vec![]
            }
        );
    }

    /// Full loopback sign-in against a mock token endpoint.
    #[tokio::test]
    async fn signs_in_through_the_loopback_redirect() {
        let id_token_claims = Arc::new(StdMutex::new(String::new()));
        let token_body = Arc::clone(&id_token_claims);
        let store = Arc::new(MemoryStore::default());
        store.set(K_CLIENT, Some("app_1")).unwrap();
        // token endpoint answers once the nonce is known
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let rec = Arc::clone(&seen);
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let n = sock.read(&mut buf).await.unwrap();
            rec.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&buf[..n]).to_string());
            let claims = token_body.lock().unwrap().clone();
            let id = format!("h.{}.s", URL_SAFE_NO_PAD.encode(claims.as_bytes()));
            let body = json!({ "access_token": "at", "refresh_token": "rt", "id_token": id, "scope": PLAN_SCOPE }).to_string();
            sock.write_all(http("200 OK", "application/json", &body).as_bytes())
                .await
                .unwrap();
            sock.shutdown().await.ok();
        });
        let ai = client(&base, Arc::clone(&store));
        let r = ai
            .sign_in(move |url| {
                let u = url::Url::parse(url).unwrap();
                let q = |k: &str| {
                    u.query_pairs()
                        .find(|(n, _)| n == k)
                        .unwrap()
                        .1
                        .into_owned()
                };
                assert_eq!(q("client_id"), "app_1");
                assert_eq!(q("code_challenge_method"), "S256");
                *id_token_claims.lock().unwrap() =
                    json!({ "nonce": q("nonce"), "aud": "app_1", "email": "me@x.y" }).to_string();
                let cb = format!("{}?state={}&code=abc", q("redirect_uri"), q("state"));
                tokio::spawn(async move {
                    let res = reqwest::get(cb).await.unwrap();
                    assert!(res.text().await.unwrap().contains("Signed in to GITVerse"));
                });
            })
            .await
            .unwrap();
        assert_eq!(r.account, "me@x.y");
        assert!(r.plan_usage);
        assert!(seen.lock().unwrap()[0].contains("code=abc"));
        assert!(ai.status().signed_in);
        assert!(!ai.status().signing_in);
        assert!(store.get(K_HOST).unwrap().starts_with("urn:uuid:"));
    }
}
