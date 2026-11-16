//! GITVerse backend core. Nothing here depends on Tauri, so it is unit-tested with plain `cargo test`
//! against the same golden fixtures as the Electron backend (`fixtures/git-contract/`).
pub mod error;
pub mod git;
pub mod state;
pub mod terminal;

pub use error::AppError;
