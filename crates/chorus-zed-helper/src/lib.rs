//! Chorus join + host helper used by the Zed extension (CLI + MCP).
//!
//! Speaks `/ws` (joiner) and `/host` (share) from `crates/chorus-relay` / `protocol/`.

pub mod client;
pub mod control;
pub mod host;
pub mod mcp;

pub use client::{JoinClient, JoinStatus, SessionSnapshot};
pub use control::{ControlRequest, ControlResponse, DaemonState};
pub use host::{HostSession, LiveSession, ShareOpts, ShareSnapshot};
