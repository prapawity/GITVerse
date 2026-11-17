use serde::Serialize;

/// Errors crossing the IPC boundary. Serialized as `{ kind, message }`; the TS adapter turns them
/// back into `Error(message)`, so existing store/UI error handling keeps working unchanged.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Git ran and failed; `message` is git's own stderr (or stdout), like the Electron backend.
    #[error("{message}")]
    Git { message: String, code: Option<i32> },
    #[error("Could not start Git: {0}")]
    Spawn(String),
    #[error("The Git command was cancelled.")]
    Cancelled,
    #[error("The Git command timed out.")]
    Timeout,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotPorted(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Git { .. } => "git",
            AppError::Spawn(_) => "spawn",
            AppError::Cancelled => "cancelled",
            AppError::Timeout => "timeout",
            AppError::Invalid(_) => "invalid",
            AppError::NotPorted(_) => "notPorted",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
