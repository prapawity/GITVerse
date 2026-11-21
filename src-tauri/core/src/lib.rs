//! GITVerse by PRAPAWITY backend core. Nothing here depends on Tauri, so it is unit-tested with plain `cargo test`
//! against the same golden fixtures as the Electron backend (`fixtures/git-contract/`).
pub mod ai;
pub mod error;
pub mod git;
pub mod hosting;
pub mod migrate;
pub mod releases;
pub mod scan;
pub mod secrets;
pub mod state;
pub mod terminal;

pub use error::{AppError, Result};
