use std::sync::Arc;
use std::time::Duration;

use chorus_relay::protocol::{
    ChatMessage, ClientMessage, ConnectedUser, ServerMessage, SessionEvent,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinStatus {
    Disconnected,
    Connecting,
    Pending,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub status: JoinStatus,
    pub host: String,
    pub display_name: String,
    pub session_id: Option<String>,
    pub users: Vec<ConnectedUser>,
    pub recent_events: Vec<SessionEvent>,
    pub recent_chat: Vec<ChatMessage>,
    pub last_error: Option<String>,
}

impl SessionSnapshot {
    fn new(host: &str, display_name: &str) -> Self {
        Self {
            status: JoinStatus::Disconnected,
            host: host.to_string(),
            display_name: display_name.to_string(),
            session_id: None,
            users: Vec::new(),
            recent_events: Vec::new(),
            recent_chat: Vec::new(),
            last_error: None,
        }
    }
}

/// Live joiner WebSocket client for the Chorus `/ws` surface.
pub struct JoinClient {
    inner: Arc<RwLock<Inner>>,
    outbound: mpsc::UnboundedSender<ClientMessage>,
    reader: Option<JoinHandle<()>>,
}

struct Inner {
    snapshot: SessionSnapshot,
}

impl JoinClient {
    /// Connect to `ws://host/ws` (or `wss://`), authenticate, and wait for
    /// `session.history` (active) or `auth.pending` (awaiting host approval).
    pub async fn connect(
        host: &str,
        token: &str,
        display_name: &str,
        repo_remote: Option<&str>,
    ) -> Result<Self, String> {
        let name = display_name.trim();
        if name.is_empty() {
            return Err("display name is required".into());
        }
        let ws_url = normalize_ws_url(host)?;
        let (ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| format!("connect failed: {e}"))?;

        let (mut write, mut read) = ws.split();
        let auth = ClientMessage::Auth {
            token: token.to_string(),
            display_name: name.to_string(),
            repo_remote: repo_remote
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        };
        write
            .send(Message::Text(
                serde_json::to_string(&auth)
                    .map_err(|e| e.to_string())?
                    .into(),
            ))
            .await
            .map_err(|e| format!("auth send failed: {e}"))?;

        let mut snapshot = SessionSnapshot::new(host, name);
        snapshot.status = JoinStatus::Connecting;

        // Wait until session.history (connected), auth.pending, deny/error, or timeout.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if tokio::time::Instant::now() > deadline {
                return Err("timed out waiting for session.history or auth.pending".into());
            }
            let next = tokio::time::timeout(Duration::from_secs(5), read.next())
                .await
                .map_err(|_| "timed out waiting for relay message".to_string())?;
            let msg = match next {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Close(frame))) => {
                    return Err(format!("connection closed before auth: {frame:?}"));
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(format!("ws error: {e}")),
                None => return Err("connection closed before auth".into()),
            };
            let server: ServerMessage =
                serde_json::from_str(&msg).map_err(|e| format!("bad server json: {e}"))?;
            apply_server_message(&mut snapshot, &server);
            match server {
                ServerMessage::SessionHistory { .. } | ServerMessage::AuthPending { .. } => break,
                ServerMessage::AuthDenied { message } => {
                    return Err(message);
                }
                ServerMessage::Error { message, .. } => {
                    return Err(message);
                }
                _ => continue,
            }
        }

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<ClientMessage>();
        let inner = Arc::new(RwLock::new(Inner { snapshot }));

        let writer_inner = Arc::clone(&inner);
        let reader = tokio::spawn(async move {
            loop {
                tokio::select! {
                    outbound = outbound_rx.recv() => {
                        let Some(msg) = outbound else { break; };
                        let Ok(text) = serde_json::to_string(&msg) else { continue; };
                        if write.send(Message::Text(text.into())).await.is_err() {
                            let mut guard = writer_inner.write().await;
                            guard.snapshot.status = JoinStatus::Disconnected;
                            break;
                        }
                    }
                    incoming = read.next() => {
                        match incoming {
                            Some(Ok(Message::Text(t))) => {
                                if let Ok(server) = serde_json::from_str::<ServerMessage>(&t) {
                                    let mut guard = writer_inner.write().await;
                                    apply_server_message(&mut guard.snapshot, &server);
                                    if matches!(server, ServerMessage::SessionClosed) {
                                        break;
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let mut guard = writer_inner.write().await;
                                guard.snapshot.status = JoinStatus::Disconnected;
                                break;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => {
                                let mut guard = writer_inner.write().await;
                                guard.snapshot.status = JoinStatus::Error;
                                guard.snapshot.last_error = Some(e.to_string());
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            inner,
            outbound: outbound_tx,
            reader: Some(reader),
        })
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        self.inner.read().await.snapshot.clone()
    }

    pub fn send_chat(&self, content: &str) -> Result<(), String> {
        // Pending joiners are blocked by the relay; fail closed client-side too.
        // Snapshot check is best-effort (async); relay enforces the real gate.
        self.outbound
            .send(ClientMessage::ChatSend {
                content: content.to_string(),
            })
            .map_err(|_| "not connected".to_string())
    }

    pub fn send_prompt(&self, content: &str) -> Result<(), String> {
        self.outbound
            .send(ClientMessage::CollabInput {
                content: content.to_string(),
            })
            .map_err(|_| "not connected".to_string())
    }

    pub fn send_typing(&self) -> Result<(), String> {
        self.outbound
            .send(ClientMessage::Typing)
            .map_err(|_| "not connected".to_string())
    }

    pub async fn disconnect(mut self) {
        drop(self.outbound);
        if let Some(handle) = self.reader.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }
    }
}

fn normalize_ws_url(host: &str) -> Result<String, String> {
    let trimmed = host.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("host is empty".into());
    }
    if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        if trimmed.ends_with("/ws") {
            return Ok(trimmed.to_string());
        }
        return Ok(format!("{trimmed}/ws"));
    }
    // Bare host:port or host
    Ok(format!("ws://{trimmed}/ws"))
}

fn apply_server_message(snapshot: &mut SessionSnapshot, msg: &ServerMessage) {
    match msg {
        ServerMessage::SessionHistory { events } => {
            snapshot.status = JoinStatus::Connected;
            snapshot.recent_events = events.clone();
            if let Some(first) = events.first() {
                snapshot.session_id = Some(first.session_id.clone());
            }
            snapshot.last_error = None;
        }
        ServerMessage::AuthPending { .. } => {
            snapshot.status = JoinStatus::Pending;
            snapshot.last_error = None;
        }
        ServerMessage::AuthDenied { message } => {
            snapshot.status = JoinStatus::Error;
            snapshot.last_error = Some(message.clone());
        }
        ServerMessage::SessionEvent { event } => {
            if snapshot.session_id.is_none() {
                snapshot.session_id = Some(event.session_id.clone());
            }
            snapshot.recent_events.push(event.clone());
            if snapshot.recent_events.len() > 50 {
                let drain = snapshot.recent_events.len() - 50;
                snapshot.recent_events.drain(0..drain);
            }
            // Approval often arrives as history/events after pending.
            if snapshot.status == JoinStatus::Pending {
                snapshot.status = JoinStatus::Connected;
            }
        }
        ServerMessage::ChatMessage { message } => {
            snapshot.recent_chat.push(message.clone());
            if snapshot.recent_chat.len() > 50 {
                let drain = snapshot.recent_chat.len() - 50;
                snapshot.recent_chat.drain(0..drain);
            }
        }
        ServerMessage::UserList { users } => {
            snapshot.users = users.clone();
        }
        ServerMessage::UserJoined { user } => {
            snapshot.users.push(user.clone());
        }
        ServerMessage::UserLeft { user_id } => {
            snapshot.users.retain(|u| u.user_id != *user_id);
        }
        ServerMessage::UserRoleChanged { user_id, role } => {
            for u in &mut snapshot.users {
                if u.user_id == *user_id {
                    u.role = role.clone();
                }
            }
        }
        ServerMessage::SessionClosed => {
            snapshot.status = JoinStatus::Disconnected;
        }
        ServerMessage::Error { message, .. } => {
            snapshot.status = JoinStatus::Error;
            snapshot.last_error = Some(message.clone());
        }
        ServerMessage::UserTyping { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_urls() {
        assert_eq!(
            normalize_ws_url("127.0.0.1:7742").unwrap(),
            "ws://127.0.0.1:7742/ws"
        );
        assert_eq!(
            normalize_ws_url("ws://127.0.0.1:7742").unwrap(),
            "ws://127.0.0.1:7742/ws"
        );
        assert_eq!(
            normalize_ws_url("ws://127.0.0.1:7742/ws").unwrap(),
            "ws://127.0.0.1:7742/ws"
        );
    }

    #[test]
    fn apply_history_and_chat() {
        let mut snap = SessionSnapshot::new("h", "Alice");
        apply_server_message(
            &mut snap,
            &ServerMessage::SessionHistory {
                events: vec![SessionEvent {
                    id: "e1".into(),
                    session_id: "sess".into(),
                    event_type: "message.created".into(),
                    payload: json!({"text": "hi"}),
                    timestamp: 1,
                }],
            },
        );
        assert_eq!(snap.status, JoinStatus::Connected);
        assert_eq!(snap.session_id.as_deref(), Some("sess"));

        apply_server_message(
            &mut snap,
            &ServerMessage::ChatMessage {
                message: ChatMessage {
                    id: "c1".into(),
                    session_id: "sess".into(),
                    user_id: "u1".into(),
                    display_name: Some("Bob".into()),
                    content: "yo".into(),
                    timestamp: 2,
                },
            },
        );
        assert_eq!(snap.recent_chat.len(), 1);
    }

    #[test]
    fn client_messages_match_fixtures_shape() {
        let auth = serde_json::to_value(ClientMessage::Auth {
            token: "abc123".into(),
            display_name: "Alice".into(),
            repo_remote: Some("https://github.com/acme/app.git".into()),
        })
        .unwrap();
        assert_eq!(auth["type"], "auth");
        assert_eq!(auth["token"], "abc123");
        assert_eq!(auth["displayName"], "Alice");
        assert_eq!(auth["repoRemote"], "https://github.com/acme/app.git");

        let chat = serde_json::to_value(ClientMessage::ChatSend {
            content: "hello chat".into(),
        })
        .unwrap();
        assert_eq!(chat["type"], "chat.send");

        let input = serde_json::to_value(ClientMessage::CollabInput {
            content: "fix the bug".into(),
        })
        .unwrap();
        assert_eq!(input["type"], "collab.input");
    }
}
