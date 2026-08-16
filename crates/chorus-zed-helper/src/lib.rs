//! Chorus join client used by the Zed helper binary (CLI + MCP).
//!
//! Speaks the joiner `/ws` contract from `crates/chorus-relay` / `protocol/`.

pub mod client;
pub mod control;
pub mod mcp;

pub use client::{JoinClient, JoinStatus, SessionSnapshot};
pub use control::{ControlRequest, ControlResponse, DaemonState};
