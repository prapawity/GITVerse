//! GitHub Copilot through a Node sidecar (electron/ai/copilotSidecar.ts). The official Copilot SDK
//! only runs on Node, so this module starts `node copilot-sidecar.mjs` on first use and talks to it
//! with one JSON object per line. The saved GitHub token stays in the keychain here and is handed
//! to the sidecar with `setToken`.
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{err, ErrKind, MessageResult, NMsg, ResolveResult, TurnResult};
use crate::secrets::SecretStore;

pub const TOKEN: &str = "ai.copilot.token";
const STOPPED: &str = "The Copilot runtime stopped unexpectedly.";

/// What the sidecar reports while a turn runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Delta {
        req_id: u64,
        text: String,
    },
    /// `{reqId, callId, name, input}`: forwarded to the renderer as `ai:toolcall`.
    ToolCall(Value),
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type OnEvent = Arc<dyn Fn(Event) + Send + Sync>;

struct Proc {
    child: Child,
    stdin: ChildStdin,
    alive: Arc<AtomicBool>,
}

pub struct Copilot {
    node: String,
    script: Option<PathBuf>,
    secrets: Arc<dyn SecretStore>,
    on_event: OnEvent,
    proc: tokio::sync::Mutex<Option<Proc>>,
    pending: Pending,
    next: AtomicU64,
}

impl Copilot {
    pub fn new(
        node: impl Into<String>,
        script: Option<PathBuf>,
        secrets: Arc<dyn SecretStore>,
        on_event: impl Fn(Event) + Send + Sync + 'static,
    ) -> Self {
        Self {
            node: node.into(),
            script,
            secrets,
            on_event: Arc::new(on_event),
            proc: tokio::sync::Mutex::new(None),
            pending: Arc::default(),
            next: AtomicU64::new(1),
        }
    }

    async fn spawn(&self) -> Result<Proc, String> {
        let script = self
            .script
            .as_ref()
            .filter(|p| p.is_file())
            .ok_or("the Copilot sidecar script is missing (run `npm run build:sidecar`).")?;
        let mut cmd = Command::new(&self.node);
        cmd.arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "could not run `{}`: {e}. Install Node.js 20 or newer.",
                self.node
            )
        })?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let alive = Arc::new(AtomicBool::new(true));
        let (pending, on_event, flag) = (
            Arc::clone(&self.pending),
            Arc::clone(&self.on_event),
            Arc::clone(&alive),
        );
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = msg["id"].as_u64() {
                    let tx = pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id);
                    if let Some(tx) = tx {
                        let r = match msg["error"].as_str() {
                            Some(e) => Err(e.to_owned()),
                            None => Ok(msg["result"].clone()),
                        };
                        let _ = tx.send(r);
                    }
                } else if msg["event"] == "delta" {
                    on_event(Event::Delta {
                        req_id: msg["reqId"].as_u64().unwrap_or(0),
                        text: msg["text"].as_str().unwrap_or_default().to_owned(),
                    });
                } else if msg["event"] == "toolcall" {
                    let mut call = msg;
                    if let Some(o) = call.as_object_mut() {
                        o.remove("event");
                    }
                    on_event(Event::ToolCall(call));
                }
            }
            flag.store(false, Ordering::SeqCst);
            for (_, tx) in pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
                let _ = tx.send(Err(STOPPED.into()));
            }
        });
        let mut p = Proc {
            child,
            stdin,
            alive,
        };
        let token = self.secrets.get(TOKEN);
        // setToken is the first request; its answer is not needed, so it is sent as a notification
        write(
            &mut p.stdin,
            &json!({ "method": "setToken", "params": { "token": token } }),
        )
        .await?;
        Ok(p)
    }

    /// Write one message, starting the sidecar first if needed.
    async fn send(&self, msg: &Value) -> Result<(), String> {
        let mut guard = self.proc.lock().await;
        if !guard
            .as_ref()
            .is_some_and(|p| p.alive.load(Ordering::SeqCst))
        {
            *guard = Some(self.spawn().await?);
        }
        let p = guard.as_mut().expect("just started");
        write(&mut p.stdin, msg).await
    }

    /// A message for a running sidecar only (tool results, aborts): never starts one.
    async fn notify(&self, method: &str, params: Value) {
        if let Some(p) = self.proc.lock().await.as_mut() {
            let _ = write(&mut p.stdin, &json!({ "method": method, "params": params })).await;
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_cancellable(method, params, None).await
    }

    /// On cancel, `abort` is sent (with `abort_params`) and the sidecar's own answer is awaited.
    async fn request_cancellable(
        &self,
        method: &str,
        params: Value,
        cancel: Option<(&CancellationToken, Value)>,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, mut rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let sent = self
            .send(&json!({ "id": id, "method": method, "params": params }))
            .await;
        if let Err(e) = sent {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(e);
        }
        if let Some((token, abort)) = cancel {
            tokio::select! {
                r = &mut rx => return r.unwrap_or_else(|_| Err(STOPPED.into())),
                _ = token.cancelled() => self.notify("abort", abort).await,
            }
        }
        rx.await.unwrap_or_else(|_| Err(STOPPED.into()))
    }

    /// `copilotStatus()`: hasToken/canEncrypt come from this side's keychain.
    pub async fn status(&self) -> Value {
        let mut s = match self.request("status", json!({})).await {
            Ok(v) if v.is_object() => v,
            r => json!({
                "available": false, "authenticated": false, "login": null, "authType": null,
                "message": format!("The Copilot runtime could not start: {}", r.err().unwrap_or_else(|| "no answer".into())),
            }),
        };
        s["hasToken"] = json!(self.secrets.get(TOKEN).is_some());
        s["canEncrypt"] = json!(self.secrets.available());
        s
    }

    pub async fn set_token(&self, token: Option<&str>) -> Result<(), String> {
        let token = token.map(str::trim).filter(|t| !t.is_empty());
        self.secrets.set(TOKEN, token).map_err(|e| e.to_string())?;
        let running = self
            .proc
            .lock()
            .await
            .as_ref()
            .is_some_and(|p| p.alive.load(Ordering::SeqCst));
        if running {
            self.request("setToken", json!({ "token": token })).await?;
        }
        Ok(())
    }

    pub async fn models(&self) -> Result<Vec<String>, String> {
        let v = self.request("models", json!({})).await?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    pub async fn begin_login(&self) -> Result<Value, String> {
        if self.secrets.get(TOKEN).is_some() {
            return Err("Remove the saved GitHub token before signing in with an account.".into());
        }
        self.request("beginLogin", json!({})).await
    }

    pub async fn advance_login(&self) -> Result<Value, String> {
        self.request("advanceLogin", json!({})).await
    }

    pub async fn cancel_login(&self) {
        if self.is_running().await {
            let _ = self.request("cancelLogin", json!({})).await;
        }
    }

    async fn is_running(&self) -> bool {
        self.proc
            .lock()
            .await
            .as_ref()
            .is_some_and(|p| p.alive.load(Ordering::SeqCst))
    }

    pub async fn turn(
        &self,
        req_id: u64,
        conv_id: Option<u64>,
        messages: &[NMsg],
        model: Option<String>,
        cancel: &CancellationToken,
    ) -> TurnResult {
        let params =
            json!({ "reqId": req_id, "convId": conv_id, "messages": messages, "model": model });
        let r = self
            .request_cancellable("turn", params, Some((cancel, json!({ "reqId": req_id }))))
            .await;
        match r {
            _ if cancel.is_cancelled() => TurnResult::aborted(),
            Ok(v) => serde_json::from_value(v).unwrap_or_else(|e| {
                TurnResult::failed(err(
                    ErrKind::Other,
                    format!("Copilot sent an unreadable answer: {e}"),
                ))
            }),
            Err(e) => TurnResult::failed(describe(&e)),
        }
    }

    pub async fn tool_result(&self, call_id: &str, text: &str, is_error: bool) {
        self.notify(
            "toolResult",
            json!({ "callId": call_id, "text": text, "isError": is_error }),
        )
        .await;
    }

    pub async fn reset(&self, conv_id: u64) {
        if self.is_running().await {
            let _ = self.request("reset", json!({ "convId": conv_id })).await;
        }
    }

    pub async fn commit_message(&self, diff: &str, model: Option<String>) -> MessageResult {
        match self
            .request("commit", json!({ "diff": diff, "model": model }))
            .await
        {
            Ok(v) => serde_json::from_value(v).unwrap_or_else(|_| {
                MessageResult::failed(err(ErrKind::Other, "Copilot returned no commit message."))
            }),
            Err(e) => MessageResult::failed(describe(&e)),
        }
    }

    pub async fn resolve(&self, prompt: &str, model: Option<String>) -> ResolveResult {
        match self
            .request("resolve", json!({ "prompt": prompt, "model": model }))
            .await
        {
            Ok(v) => serde_json::from_value(v).unwrap_or_else(|_| {
                ResolveResult::failed(err(
                    ErrKind::Other,
                    "Copilot returned no answer. Try again.",
                ))
            }),
            Err(e) => ResolveResult::failed(describe(&e)),
        }
    }

    /// App exit: ask the sidecar to stop the Copilot runtime, then kill it.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.proc.try_lock() {
            if let Some(mut p) = guard.take() {
                let _ = p.child.start_kill();
            }
        }
    }
}

async fn write(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|_| STOPPED.to_owned())?;
    stdin.flush().await.map_err(|_| STOPPED.to_owned())
}

/// Transport failures (the sidecar could not start or died); provider errors arrive already mapped.
fn describe(m: &str) -> super::AiErr {
    err(
        ErrKind::Other,
        format!("The Copilot runtime could not start: {m}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    /// A stand-in for the real sidecar that speaks the same protocol.
    const FAKE: &str = r#"
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let token = null, pending = null;
rl.on('line', (l) => {
  const m = JSON.parse(l), p = m.params || {};
  if (m.method === 'setToken') { token = p.token; if (m.id) send({ id: m.id, result: null }); return; }
  if (m.method === 'toolResult') { pending({ id: pending.id, result: { ok: true, text: 'tool said ' + p.text, calls: [], stop: 'end' } }); return; }
  if (m.method === 'abort') { send({ id: pending.id, result: { ok: false, aborted: true } }); return; }
  if (m.method === 'status') send({ id: m.id, result: { available: true, authenticated: !!token, login: token, authType: null, message: null } });
  else if (m.method === 'models') send({ id: m.id, result: ['gpt-5', 'claude-x'] });
  else if (m.method === 'turn') {
    send({ event: 'delta', reqId: p.reqId, text: 'hi' });
    if (p.messages[0].text === 'hang') { pending = { id: m.id }; return; }
    pending = (r) => send(r); pending.id = m.id;
    send({ event: 'toolcall', reqId: p.reqId, callId: 'c1', name: 'get_repo_status', input: {} });
  } else send({ id: m.id, error: 'not logged in' });
});
"#;

    fn node_ok() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn fake(dir: &tempfile::TempDir) -> PathBuf {
        let p = dir.path().join("fake.cjs");
        std::fs::write(&p, FAKE).unwrap();
        p
    }

    #[tokio::test]
    async fn talks_to_the_sidecar() {
        if !node_ok() {
            eprintln!("node not found: skipped");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryStore::default());
        store.set(TOKEN, Some("gho_x")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        let cop = Arc::new(Copilot::new("node", Some(fake(&dir)), store, move |e| {
            seen.lock().unwrap().push(e)
        }));

        let s = cop.status().await;
        assert_eq!(s["login"], "gho_x", "token handed over at start: {s}");
        assert_eq!(s["hasToken"], true);
        assert_eq!(cop.models().await.unwrap(), ["gpt-5", "claude-x"]);

        // a turn that runs a tool through the app
        let runner = Arc::clone(&cop);
        let turn = tokio::spawn(async move {
            runner
                .turn(
                    7,
                    Some(1),
                    &[NMsg::User { text: "go".into() }],
                    None,
                    &CancellationToken::new(),
                )
                .await
        });
        for _ in 0..100 {
            if events.lock().unwrap().len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        cop.tool_result("c1", "clean", false).await;
        let r = turn.await.unwrap();
        let TurnResult::Done { text, .. } = r else {
            panic!("{r:?}")
        };
        assert_eq!(text, "tool said clean");
        let ev = events.lock().unwrap().clone();
        assert_eq!(
            ev[0],
            Event::Delta {
                req_id: 7,
                text: "hi".into()
            }
        );
        let Event::ToolCall(call) = &ev[1] else {
            panic!()
        };
        assert_eq!(call["callId"], "c1");
        assert!(call.get("event").is_none());

        // cancelling sends abort and returns aborted
        let cancel = CancellationToken::new();
        let runner = Arc::clone(&cop);
        let c2 = cancel.clone();
        let turn = tokio::spawn(async move {
            runner
                .turn(
                    8,
                    None,
                    &[NMsg::User {
                        text: "hang".into(),
                    }],
                    None,
                    &c2,
                )
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel.cancel();
        assert_eq!(turn.await.unwrap(), TurnResult::aborted());

        // errors from the sidecar map to results
        let MessageResult::Failed { error, .. } = cop.commit_message("d", None).await else {
            panic!()
        };
        assert!(error.message.contains("not logged in"));
        cop.shutdown();
    }

    #[tokio::test]
    async fn a_missing_script_reports_unavailable() {
        let cop = Copilot::new("node", None, Arc::new(MemoryStore::default()), |_| {});
        let s = cop.status().await;
        assert_eq!(s["available"], false);
        assert!(s["message"].as_str().unwrap().contains("build:sidecar"));
        let r = cop
            .turn(1, None, &[], None, &CancellationToken::new())
            .await;
        assert!(matches!(r, TurnResult::Failed { .. }));
    }
}
