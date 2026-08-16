//! JSON-line control protocol between CLI subcommands and the background daemon.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::client::{JoinStatus, SessionSnapshot};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum ControlRequest {
    Ping,
    Join {
        host: String,
        token: String,
        #[serde(default = "default_display_name")]
        display_name: String,
    },
    Leave,
    Chat {
        content: String,
    },
    Prompt {
        content: String,
    },
    Status,
    Shutdown,
}

fn default_display_name() -> String {
    "Zed".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SessionSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ControlResponse {
    pub fn ok_msg(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            error: None,
            snapshot: None,
            message: Some(message.into()),
        }
    }

    pub fn ok_status(snapshot: SessionSnapshot) -> Self {
        Self {
            ok: true,
            error: None,
            snapshot: Some(snapshot),
            message: None,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            snapshot: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub status: Option<JoinStatus>,
    pub host: Option<String>,
}

pub fn runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CHORUS_ZED_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("chorus-zed");
    }
    std::env::temp_dir().join(format!(
        "chorus-zed-{}",
        std::env::var("USER").unwrap_or_else(|_| "user".into())
    ))
}

pub fn socket_path() -> PathBuf {
    runtime_dir().join("control.sock")
}

pub fn pid_path() -> PathBuf {
    runtime_dir().join("daemon.pid")
}
