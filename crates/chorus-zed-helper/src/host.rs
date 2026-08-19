//! Host/share client: in-process `chorus-relay` plus `/host` control WebSocket.
//!
//! Same contract as `@chorus/client` `RelayServer` / the VS Code adapter. Zed
//! still does not drive an OpenCode LLM loop — joiner `collab.input` is recorded
//! on the host snapshot for the agent/CLI to act on.

use std::io::Read;
use std::net::UdpSocket;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chorus_relay::protocol::{
    ChatMessage, ConnectedUser, HostToRelay, RelayToHost, SessionEvent, SessionToken, UserRole,
};
use chorus_relay::server::{serve, RelayConfig};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::client::JoinClient;

const DEFAULT_PORT: u16 = 7742;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct ShareOpts {
    pub port: u16,
    pub role: UserRole,
    pub display_name: String,
    pub require_approval: bool,
    pub repo_remote: Option<String>,
    pub allowed_email_domain: Option<String>,
    pub public_host: Option<String>,
}

impl Default for ShareOpts {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            role: UserRole::Edit,
            display_name: default_host_name(),
            require_approval: true,
            repo_remote: None,
            allowed_email_domain: None,
            public_host: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSnapshot {
    pub sharing: bool,
    pub port: u16,
    pub host: String,
    pub display_name: String,
    pub session_id: String,
    pub join_command: String,
    pub require_approval: bool,
    pub pending_users: Vec<ConnectedUser>,
    pub users: Vec<ConnectedUser>,
    pub recent_inputs: Vec<String>,
    pub recent_chat: Vec<ChatMessage>,
    pub last_error: Option<String>,
}

pub struct HostSession {
    inner: Arc<RwLock<Inner>>,
    outbound: mpsc::UnboundedSender<HostToRelay>,
    reader: Option<JoinHandle<()>>,
    server: Option<JoinHandle<()>>,
}

struct Inner {
    snapshot: ShareSnapshot,
    pending_token: Option<oneshot::Sender<Result<SessionToken, String>>>,
}

pub enum LiveSession {
    Idle,
    Joined(JoinClient),
    Sharing(HostSession),
}

impl LiveSession {
    pub async fn shutdown(&mut self) {
        match std::mem::replace(self, LiveSession::Idle) {
            LiveSession::Idle => {}
            LiveSession::Joined(client) => client.disconnect().await,
            LiveSession::Sharing(host) => host.stop().await,
        }
    }
}

impl HostSession {
    pub async fn start(mut opts: ShareOpts) -> Result<Self, String> {
        let name = opts.display_name.trim();
        if name.is_empty() {
            return Err("display name is required".into());
        }
        opts.display_name = name.to_string();
        if opts.port == 0 {
            opts.port = DEFAULT_PORT;
        }
        if opts.repo_remote.is_none() {
            opts.repo_remote = detect_repo_remote(None);
        }

        let host_token = random_hex(32)?;
        let session_id = format!("zed-{}", random_hex(6)?);
        let config = RelayConfig {
            port: opts.port,
            host_token: host_token.clone(),
            bind: "0.0.0.0".into(),
        };
        let server = tokio::spawn(async move {
            if let Err(e) = serve(config).await {
                tracing::error!("chorus-relay serve failed: {e}");
            }
        });

        wait_for_port(opts.port).await.map_err(|e| {
            server.abort();
            e
        })?;

        let ws_url = format!("ws://127.0.0.1:{}/host", opts.port);
        let (ws, _) = connect_async(&ws_url).await.map_err(|e| {
            server.abort();
            format!("host control connect failed: {e}")
        })?;
        let (mut write, mut read) = ws.split();
        write
            .send(Message::Text(
                serde_json::to_string(&HostToRelay::HostAuth { token: host_token })
                    .map_err(|e| e.to_string())?
                    .into(),
            ))
            .await
            .map_err(|e| format!("host.auth send failed: {e}"))?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            if tokio::time::Instant::now() > deadline {
                server.abort();
                return Err("timed out waiting for host.ready".into());
            }
            let next = tokio::time::timeout(Duration::from_secs(5), read.next())
                .await
                .map_err(|_| "timed out waiting for host.ready".to_string())?;
            match next {
                Some(Ok(Message::Text(t))) => {
                    let msg: RelayToHost =
                        serde_json::from_str(&t).map_err(|e| format!("bad host json: {e}"))?;
                    if matches!(msg, RelayToHost::HostReady { .. }) {
                        break;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    server.abort();
                    return Err(format!("host control closed before ready: {frame:?}"));
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => {
                    server.abort();
                    return Err(format!("host ws error: {e}"));
                }
                None => {
                    server.abort();
                    return Err("host control closed before ready".into());
                }
            }
        }

        let advertised = opts
            .public_host
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("{}:{}", lan_ip(), opts.port));

        let inner = Arc::new(RwLock::new(Inner {
            snapshot: ShareSnapshot {
                sharing: true,
                port: opts.port,
                host: advertised.clone(),
                display_name: opts.display_name.clone(),
                session_id: session_id.clone(),
                join_command: String::new(),
                require_approval: opts.require_approval,
                pending_users: Vec::new(),
                users: Vec::new(),
                recent_inputs: Vec::new(),
                recent_chat: Vec::new(),
                last_error: None,
            },
            pending_token: None,
        }));

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<HostToRelay>();
        let reader_inner = Arc::clone(&inner);
        let reader = tokio::spawn(async move {
            loop {
                tokio::select! {
                    outbound = outbound_rx.recv() => {
                        let Some(msg) = outbound else { break; };
                        let Ok(text) = serde_json::to_string(&msg) else { continue; };
                        if write.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    incoming = read.next() => {
                        match incoming {
                            Some(Ok(Message::Text(t))) => {
                                if let Ok(msg) = serde_json::from_str::<RelayToHost>(&t) {
                                    apply_host_message(&reader_inner, msg).await;
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Ok(_)) => {}
                            Some(Err(e)) => {
                                let mut guard = reader_inner.write().await;
                                guard.snapshot.last_error = Some(e.to_string());
                                break;
                            }
                        }
                    }
                }
            }
        });

        let session = Self {
            inner: Arc::clone(&inner),
            outbound: outbound_tx,
            reader: Some(reader),
            server: Some(server),
        };

        session.send(HostToRelay::SessionPolicy {
            require_approval: Some(opts.require_approval),
            repo_remote: Some(opts.repo_remote.clone().unwrap_or_default()),
            allowed_email_domain: opts.allowed_email_domain.clone(),
            additional_repo_remote_prefixes: None,
            repo_remote_rewrites: None,
        })?;

        let token = session
            .issue_token(&session_id, opts.role.clone())
            .await?;
        let join_command = format!(
            "/chorus-join token=\"{}\" host=\"{}\"",
            token.token, advertised
        );
        {
            let mut guard = inner.write().await;
            guard.snapshot.join_command = join_command;
        }

        Ok(session)
    }

    async fn issue_token(&self, session_id: &str, role: UserRole) -> Result<SessionToken, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.inner.write().await;
            guard.pending_token = Some(tx);
        }
        self.send(HostToRelay::TokenIssue {
            session_id: session_id.to_string(),
            role: Some(role),
            ttl_ms: None,
        })?;
        match tokio::time::timeout(TOKEN_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("token.issue channel closed".into()),
            Err(_) => Err("token.issue timed out".into()),
        }
    }

    fn send(&self, msg: HostToRelay) -> Result<(), String> {
        self.outbound
            .send(msg)
            .map_err(|_| "host control not connected".to_string())
    }

    pub async fn snapshot(&self) -> ShareSnapshot {
        self.inner.read().await.snapshot.clone()
    }

    pub fn approve(&self, user_id: &str) -> Result<(), String> {
        self.send(HostToRelay::HostApprove {
            user_id: user_id.to_string(),
        })
    }

    pub fn deny(&self, user_id: &str) -> Result<(), String> {
        self.send(HostToRelay::HostDeny {
            user_id: user_id.to_string(),
        })
    }

    pub async fn send_chat_named(&self, content: &str) -> Result<(), String> {
        let name = self.inner.read().await.snapshot.display_name.clone();
        self.send(HostToRelay::ChatSend {
            content: content.to_string(),
            display_name: Some(name),
        })
    }

    pub async fn publish(&self, content: &str, event_type: &str) -> Result<(), String> {
        let (session_id, id) = {
            let snap = self.inner.read().await;
            (snap.snapshot.session_id.clone(), format!("{}-{}", now_ms(), random_hex(4).unwrap_or_else(|_| "id".into())))
        };
        let ty = match event_type {
            "assistant" | "ai" => "assistant",
            _ => "user",
        };
        self.send(HostToRelay::SessionEvent {
            event: SessionEvent {
                id,
                session_id,
                event_type: ty.into(),
                payload: serde_json::Value::String(content.to_string()),
                timestamp: now_ms(),
            },
        })
    }

    pub async fn stop(mut self) {
        let _ = self.send(HostToRelay::HostClose);
        drop(self.outbound);
        if let Some(handle) = self.reader.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }
        if let Some(handle) = self.server.take() {
            handle.abort();
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }
    }
}

async fn apply_host_message(inner: &Arc<RwLock<Inner>>, msg: RelayToHost) {
    let mut guard = inner.write().await;
    match msg {
        RelayToHost::TokenIssued { token } => {
            if let Some(tx) = guard.pending_token.take() {
                let _ = tx.send(Ok(token));
            }
        }
        RelayToHost::Error { message, .. } => {
            if let Some(tx) = guard.pending_token.take() {
                let _ = tx.send(Err(message.clone()));
            }
            guard.snapshot.last_error = Some(message);
        }
        RelayToHost::CollabInput {
            user_id,
            display_name,
            content,
        } => {
            let label = display_name.unwrap_or_else(|| user_id.chars().take(8).collect());
            guard
                .snapshot
                .recent_inputs
                .push(format!("[{label}]: {content}"));
            if guard.snapshot.recent_inputs.len() > 50 {
                let drain = guard.snapshot.recent_inputs.len() - 50;
                guard.snapshot.recent_inputs.drain(0..drain);
            }
        }
        RelayToHost::ChatMessage { message } => {
            guard.snapshot.recent_chat.push(message);
            if guard.snapshot.recent_chat.len() > 50 {
                let drain = guard.snapshot.recent_chat.len() - 50;
                guard.snapshot.recent_chat.drain(0..drain);
            }
        }
        RelayToHost::UserPending { user } => {
            guard
                .snapshot
                .pending_users
                .retain(|u| u.user_id != user.user_id);
            guard.snapshot.pending_users.push(user);
        }
        RelayToHost::UserJoined { user } => {
            guard
                .snapshot
                .pending_users
                .retain(|u| u.user_id != user.user_id);
            guard
                .snapshot
                .users
                .retain(|u| u.user_id != user.user_id);
            guard.snapshot.users.push(user);
        }
        RelayToHost::UserLeft { user_id } => {
            guard
                .snapshot
                .pending_users
                .retain(|u| u.user_id != user_id);
            guard.snapshot.users.retain(|u| u.user_id != user_id);
        }
        RelayToHost::UserList { users } => {
            guard.snapshot.users = users
                .iter()
                .filter(|u| {
                    matches!(u.status, chorus_relay::protocol::UserStatus::Active)
                })
                .cloned()
                .collect();
            guard.snapshot.pending_users = users
                .into_iter()
                .filter(|u| {
                    matches!(u.status, chorus_relay::protocol::UserStatus::Pending)
                })
                .collect();
        }
        _ => {}
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("entropy: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn default_host_name() -> String {
    std::env::var("CHORUS_DISPLAY_NAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USER").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Zed".into())
}

pub fn parse_role(raw: &str) -> Result<UserRole, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "edit" => Ok(UserRole::Edit),
        "view" => Ok(UserRole::View),
        "admin" => Ok(UserRole::Admin),
        other => Err(format!("unknown role '{other}' (edit|view|admin)")),
    }
}

pub fn lan_ip() -> String {
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".into()
}

pub fn detect_repo_remote(cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["remote", "get-url", "origin"]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let remote = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if remote.is_empty() {
        None
    } else {
        Some(remote)
    }
}

async fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(format!(
        "chorus-relay did not become ready on port {port} (is it already in use?)"
    ))
}

pub fn format_share_status(snap: &ShareSnapshot) -> String {
    let mut out = String::new();
    out.push_str("status: sharing\n");
    out.push_str(&format!("host: {}\n", snap.host));
    out.push_str(&format!("port: {}\n", snap.port));
    out.push_str(&format!("displayName: {}\n", snap.display_name));
    out.push_str(&format!("sessionId: {}\n", snap.session_id));
    out.push_str(&format!("requireApproval: {}\n", snap.require_approval));
    out.push_str(&format!("joinCommand: {}\n", snap.join_command));
    if let Some(err) = &snap.last_error {
        out.push_str(&format!("error: {err}\n"));
    }
    out.push_str(&format!("pending ({})\n", snap.pending_users.len()));
    for u in &snap.pending_users {
        out.push_str(&format!(
            "  - {} [{}] {:?}\n",
            u.display_name, u.user_id, u.role
        ));
    }
    out.push_str(&format!("users ({})\n", snap.users.len()));
    for u in &snap.users {
        out.push_str(&format!(
            "  - {} [{}] {:?}\n",
            u.display_name, u.user_id, u.role
        ));
    }
    out.push_str(&format!(
        "recentInputs: {} | recentChat: {}\n",
        snap.recent_inputs.len(),
        snap.recent_chat.len()
    ));
    for line in snap.recent_inputs.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev()
    {
        out.push_str(&format!("  prompt {line}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roles() {
        assert!(matches!(parse_role("edit"), Ok(UserRole::Edit)));
        assert!(matches!(parse_role("ADMIN"), Ok(UserRole::Admin)));
        assert!(parse_role("owner").is_err());
    }
}
