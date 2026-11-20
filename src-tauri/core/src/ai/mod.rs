//! AI providers for the in-app assistant (port of electron/ai). The renderer owns the conversation
//! and runs tools; the backend holds credentials and talks to the provider APIs.
pub mod claude;
pub mod copilot;
pub mod openai;
mod sse;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// src/shared/aiSpec.json, generated from src/shared/aiTools.ts (scripts/ai-spec.ts).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSpec {
    pub model: String,
    pub system: String,
    pub conflict_system: String,
    pub commit_system: String,
    pub pr_system: String,
    pub tools: Value,
    pub conflict_format: Value,
}

pub fn spec() -> &'static AiSpec {
    static SPEC: std::sync::OnceLock<AiSpec> = std::sync::OnceLock::new();
    SPEC.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../src/shared/aiSpec.json"))
            .expect("valid aiSpec.json")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Openai,
    Copilot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub text: String,
    pub is_error: bool,
}

/// The conversation as the app keeps it (`NMsg` in src/shared/aiTypes.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum NMsg {
    User {
        text: String,
    },
    Assistant {
        #[serde(default)]
        text: String,
        #[serde(default)]
        calls: Vec<ToolCall>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<Provider>,
    },
    Tool {
        results: Vec<ToolResult>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrKind {
    Auth,
    Rate,
    Usage,
    Network,
    Api,
    Refusal,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiErr {
    pub kind: ErrKind,
    pub message: String,
}

pub fn err(kind: ErrKind, message: impl Into<String>) -> AiErr {
    AiErr {
        kind,
        message: message.into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stop {
    End,
    Tool,
    Refusal,
    Max,
}

/// `TurnResult` in aiTypes.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TurnResult {
    Done {
        ok: bool,
        text: String,
        calls: Vec<ToolCall>,
        #[serde(skip_serializing_if = "Option::is_none")]
        native: Option<Value>,
        stop: Stop,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Aborted {
        ok: bool,
        aborted: bool,
    },
    Failed {
        ok: bool,
        error: AiErr,
    },
}

impl TurnResult {
    pub fn aborted() -> Self {
        TurnResult::Aborted {
            ok: false,
            aborted: true,
        }
    }
    pub fn failed(error: AiErr) -> Self {
        TurnResult::Failed { ok: false, error }
    }
}

/// `MessageResult` in aiTypes.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageResult {
    Ok { ok: bool, text: String },
    Failed { ok: bool, error: AiErr },
}

impl MessageResult {
    pub fn ok(text: String) -> Self {
        MessageResult::Ok { ok: true, text }
    }
    pub fn failed(error: AiErr) -> Self {
        MessageResult::Failed { ok: false, error }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    pub index: i64,
    pub resolved: String,
    pub explanation: String,
}

/// `ResolveResult` in aiTypes.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResolveResult {
    Ok {
        ok: bool,
        resolutions: Vec<Resolution>,
    },
    Failed {
        ok: bool,
        error: AiErr,
    },
}

impl ResolveResult {
    pub fn failed(error: AiErr) -> Self {
        ResolveResult::Failed { ok: false, error }
    }

    /// Keep only entries for regions that exist, and never accept leftover conflict markers.
    pub fn sanitized(self, count: usize) -> Self {
        match self {
            ResolveResult::Ok { resolutions, .. } => ResolveResult::Ok {
                ok: true,
                resolutions: resolutions
                    .into_iter()
                    .filter(|r| r.index >= 0 && (r.index as usize) < count)
                    .filter(|r| {
                        !r.resolved.lines().any(|l| {
                            ["<<<<<<<", "=======", ">>>>>>>"]
                                .iter()
                                .any(|m| l.starts_with(m))
                        })
                    })
                    .collect(),
            },
            failed => failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_embedded() {
        let s = spec();
        assert!(s.model.starts_with("claude-"));
        assert!(s.tools.as_array().is_some_and(|t| !t.is_empty()));
        assert_eq!(s.conflict_format["type"], "json_schema");
    }

    #[test]
    fn messages_round_trip_like_the_ts_shapes() {
        let json = serde_json::json!([
            { "role": "user", "text": "hi" },
            { "role": "assistant", "text": "", "calls": [{ "id": "t1", "name": "fetch", "input": {} }], "by": "claude", "native": [] },
            { "role": "tool", "results": [{ "id": "t1", "text": "done", "isError": false }] }
        ]);
        let msgs: Vec<NMsg> = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&msgs).unwrap(), json);
    }

    #[test]
    fn resolutions_drop_bad_indices_and_markers() {
        let r = ResolveResult::Ok {
            ok: true,
            resolutions: vec![
                Resolution {
                    index: 0,
                    resolved: "ok".into(),
                    explanation: String::new(),
                },
                Resolution {
                    index: 5,
                    resolved: "out of range".into(),
                    explanation: String::new(),
                },
                Resolution {
                    index: 1,
                    resolved: "a\n=======\nb".into(),
                    explanation: String::new(),
                },
            ],
        };
        let ResolveResult::Ok { resolutions, .. } = r.sanitized(2) else {
            panic!()
        };
        assert_eq!(resolutions.len(), 1);
    }
}
