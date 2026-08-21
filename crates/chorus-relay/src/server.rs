use crate::access::AccessManager;
use crate::netallow::{is_open_bind, NetworkAllowlist};
use crate::protocol::{
    email_matches_domain, normalize_display_name, normalize_email, sanitize_repo_remote_prefixes,
    sanitize_repo_remote_rewrites, ChatMessage, ClientMessage, HostToRelay, RelayToHost,
    ServerMessage, SessionPolicy, UserRole, UserStatus,
};
use crate::state::{ClientTx, HostTx, RelayState, SharedState};
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, RwLock};
use tower_http::trace::TraceLayer;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[derive(Clone)]
pub struct AppState {
    pub relay: SharedState,
    pub host_token: Arc<String>,
    pub allowlist: Arc<NetworkAllowlist>,
}

pub struct RelayConfig {
    pub port: u16,
    pub host_token: String,
    pub bind: String,
    /// When non-empty, only these CIDRs (plus loopback if enabled) may connect.
    pub allowed_cidrs: Vec<String>,
    /// When false, refuse bind to 0.0.0.0 / :: (enterprise default for MDM).
    pub allow_open_bind: bool,
    /// When allowlist is set, still admit 127.0.0.0/8 and ::1 (host plugin).
    pub allow_loopback: bool,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            port: 7742,
            host_token: String::new(),
            bind: "0.0.0.0".into(),
            allowed_cidrs: Vec::new(),
            allow_open_bind: true,
            allow_loopback: true,
        }
    }
}

fn peer_allowed(state: &AppState, peer: SocketAddr) -> bool {
    state.allowlist.allows_socket(peer)
}

pub async fn serve(config: RelayConfig) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !config.allow_open_bind && is_open_bind(&config.bind) {
        return Err(format!(
            "refusing open bind {} (set --bind to a private address or enable --allow-open-bind)",
            config.bind
        )
        .into());
    }

    let allowlist = NetworkAllowlist::parse(&config.allowed_cidrs, config.allow_loopback)?;
    if allowlist.is_restricted() {
        let cidrs: Vec<String> = allowlist.cidrs().collect();
        tracing::info!(
            "network allowlist enabled (loopback={}): {}",
            config.allow_loopback,
            cidrs.join(", ")
        );
    }

    let state = AppState {
        relay: Arc::new(RwLock::new(RelayState::new(config.port))),
        host_token: Arc::new(config.host_token),
        allowlist: Arc::new(allowlist),
    };

    let app = Router::new()
        .route("/", get(root))
        .route("/status", get(status))
        .route("/ws", get(ws_joiner))
        .route("/host", get(ws_host))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", config.bind, config.port).parse()?;
    tracing::info!("chorus-relay listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn root(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !peer_allowed(&state, peer) {
        return (
            StatusCode::FORBIDDEN,
            "chorus relay — peer not on network allowlist",
        )
            .into_response();
    }
    "chorus relay — OpenCode only".into_response()
}

async fn status(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !peer_allowed(&state, peer) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "status": "forbidden",
                "error": "peer not on network allowlist",
            })),
        )
            .into_response();
    }
    let guard = state.relay.read().await;
    let cidrs: Vec<String> = state.allowlist.cidrs().collect();
    Json(serde_json::json!({
        "status": "ok",
        "clients": guard.client_count(),
        "network": {
            "allowlist": cidrs,
            "restricted": state.allowlist.is_restricted(),
        },
    }))
    .into_response()
}

async fn ws_joiner(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !peer_allowed(&state, peer) {
        tracing::warn!(%peer, "rejected /ws: not on network allowlist");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "NETWORK_ACCESS_DENIED",
                "message": "Peer address is not on the relay network allowlist",
            })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_joiner(socket, state.relay))
        .into_response()
}

async fn ws_host(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !peer_allowed(&state, peer) {
        tracing::warn!(%peer, "rejected /host: not on network allowlist");
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "NETWORK_ACCESS_DENIED",
                "message": "Peer address is not on the relay network allowlist",
            })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_host(socket, state.relay, state.host_token))
        .into_response()
}

fn admit_active(guard: &mut RelayState, uid: &str, user: &crate::protocol::ConnectedUser, tx: &ClientTx) {
    let history = ServerMessage::SessionHistory {
        events: guard.event_history.clone(),
    };
    let others = ServerMessage::UserList {
        users: guard
            .access
            .list_active_users()
            .into_iter()
            .filter(|u| u.user_id != uid)
            .collect(),
    };
    let _ = tx.send(text_msg(&history));
    let _ = tx.send(text_msg(&others));

    let joined = ServerMessage::UserJoined { user: user.clone() };
    guard.broadcast_active_except(uid, &joined);
    guard.send_host(&RelayToHost::UserJoined { user: user.clone() });
}

async fn handle_joiner(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx): (ClientTx, _) = mpsc::unbounded_channel();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut user_id: Option<String> = None;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: ClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => {
                let _ = tx.send(text_msg(&ServerMessage::Error {
                    code: "BAD_MESSAGE".into(),
                    message: "Invalid JSON".into(),
                }));
                continue;
            }
        };

        match parsed {
            ClientMessage::Auth {
                token,
                display_name,
                repo_remote,
                email,
            } => {
                if user_id.is_some() {
                    continue;
                }

                let Some(display_name) = normalize_display_name(&display_name) else {
                    let _ = tx.send(text_msg(&ServerMessage::Error {
                        code: "NAME_REQUIRED".into(),
                        message: "A non-empty displayName is required to join".into(),
                    }));
                    let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: axum::extract::ws::CloseCode::from(4002u16),
                        reason: "name required".into(),
                    })));
                    break;
                };

                let email = match email.as_deref() {
                    None => None,
                    Some(raw) if raw.trim().is_empty() => None,
                    Some(raw) => {
                        let Some(normalized) = normalize_email(raw) else {
                            let _ = tx.send(text_msg(&ServerMessage::Error {
                                code: "EMAIL_INVALID".into(),
                                message: "A valid email address is required to join".into(),
                            }));
                            let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::CloseCode::from(4005u16),
                                reason: "invalid email".into(),
                            })));
                            break;
                        };
                        Some(normalized)
                    }
                };

                let mut guard = state.write().await;

                if let Some(ref expected) = guard.policy.repo_remote {
                    let provided = repo_remote
                        .as_deref()
                        .map(|raw| guard.policy.normalize_remote(raw))
                        .filter(|s| !s.is_empty());
                    if provided.as_ref() != Some(expected) {
                        let _ = tx.send(text_msg(&ServerMessage::Error {
                            code: "REPO_ACCESS_DENIED".into(),
                            message: "Joiner must be in a clone of the host session repository"
                                .into(),
                        }));
                        drop(guard);
                        let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: axum::extract::ws::CloseCode::from(4004u16),
                            reason: "repo access denied".into(),
                        })));
                        break;
                    }
                }

                if let Some(ref domain) = guard.policy.allowed_email_domain {
                    let normalized_domain = domain
                        .trim()
                        .trim_start_matches('@')
                        .to_ascii_lowercase();
                    if !normalized_domain.is_empty() {
                        let Some(ref em) = email else {
                            let _ = tx.send(text_msg(&ServerMessage::Error {
                                code: "EMAIL_REQUIRED".into(),
                                message: "A company email address is required to join".into(),
                            }));
                            drop(guard);
                            let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::CloseCode::from(4006u16),
                                reason: "email required".into(),
                            })));
                            break;
                        };
                        if !email_matches_domain(em, &normalized_domain) {
                            let _ = tx.send(text_msg(&ServerMessage::Error {
                                code: "EMAIL_ACCESS_DENIED".into(),
                                message: "Joiner must use an email at the configured company domain"
                                    .into(),
                            }));
                            drop(guard);
                            let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::CloseCode::from(4007u16),
                                reason: "email access denied".into(),
                            })));
                            break;
                        }
                    }
                }

                let st = guard.access.validate_token(&token);
                let Some(st) = st else {
                    let _ = tx.send(text_msg(&ServerMessage::Error {
                        code: "AUTH_FAILED".into(),
                        message: "Invalid or expired token".into(),
                    }));
                    drop(guard);
                    let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: axum::extract::ws::CloseCode::from(4001u16),
                        reason: "auth failed".into(),
                    })));
                    break;
                };

                let uid = AccessManager::new_user_id();
                let status = if guard.policy.require_approval {
                    UserStatus::Pending
                } else {
                    UserStatus::Active
                };
                let user = guard
                    .access
                    .add_user(uid.clone(), st.granted_role, display_name, email, status);
                guard.clients.insert(uid.clone(), tx.clone());

                if user.status == UserStatus::Pending {
                    let _ = tx.send(text_msg(&ServerMessage::AuthPending {
                        user_id: uid.clone(),
                        message: Some("Waiting for host approval".into()),
                    }));
                    guard.send_host(&RelayToHost::UserPending {
                        user: user.clone(),
                    });
                } else {
                    admit_active(&mut guard, &uid, &user, &tx);
                }

                user_id = Some(uid);
            }

            other => {
                let Some(ref uid) = user_id else {
                    let _ = tx.send(text_msg(&ServerMessage::Error {
                        code: "NOT_AUTHED".into(),
                        message: "Send auth first".into(),
                    }));
                    continue;
                };
                handle_joiner_message(&state, uid, other, &tx).await;
            }
        }
    }

    if let Some(uid) = user_id {
        let mut guard = state.write().await;
        let was_active = guard.access.is_active(&uid);
        guard.access.remove_user(&uid);
        guard.clients.remove(&uid);
        if was_active {
            let left = ServerMessage::UserLeft {
                user_id: uid.clone(),
            };
            guard.broadcast_active(&left);
        }
        guard.send_host(&RelayToHost::UserLeft { user_id: uid });
    }

    // Drop the sender so the writer drains queued frames (errors/close) then exits.
    drop(tx);
    let _ = writer.await;
}

async fn handle_joiner_message(
    state: &SharedState,
    user_id: &str,
    msg: ClientMessage,
    tx: &ClientTx,
) {
    match msg {
        ClientMessage::Typing => {
            let guard = state.read().await;
            if !guard.access.is_active(user_id) {
                let _ = tx.send(text_msg(&ServerMessage::Error {
                    code: "PENDING".into(),
                    message: "Waiting for host approval".into(),
                }));
                return;
            }
            let display_name = guard
                .access
                .get_user(user_id)
                .map(|u| u.display_name.clone());
            let typing = ServerMessage::UserTyping {
                user_id: user_id.to_string(),
                display_name: display_name.clone(),
            };
            guard.broadcast_active_except(user_id, &typing);
            guard.send_host(&RelayToHost::UserTyping {
                user_id: user_id.to_string(),
                display_name,
            });
        }

        ClientMessage::ChatSend { content } => {
            let mut guard = state.write().await;
            if !guard.access.is_active(user_id) {
                let _ = tx.send(text_msg(&ServerMessage::Error {
                    code: "PENDING".into(),
                    message: "Waiting for host approval".into(),
                }));
                return;
            }
            let display_name = guard
                .access
                .get_user(user_id)
                .map(|u| u.display_name.clone());
            let chat = ChatMessage {
                id: random_hex(8),
                session_id: String::new(),
                user_id: user_id.to_string(),
                display_name: display_name.clone(),
                content: content.clone(),
                timestamp: now_ms(),
            };
            guard.chat_history.push(chat.clone());
            let wire = ServerMessage::ChatMessage {
                message: chat.clone(),
            };
            guard.broadcast_active(&wire);
            guard.send_host(&RelayToHost::ChatMessage { message: chat });
        }

        ClientMessage::CollabInput { content } => {
            let guard = state.read().await;
            if !guard.access.is_active(user_id) {
                let _ = tx.send(text_msg(&ServerMessage::Error {
                    code: "PENDING".into(),
                    message: "Waiting for host approval".into(),
                }));
                return;
            }
            if !guard.access.can_send_input(user_id) {
                let _ = tx.send(text_msg(&ServerMessage::Error {
                    code: "FORBIDDEN".into(),
                    message: "Viewer cannot send LLM input".into(),
                }));
                return;
            }
            let display_name = guard
                .access
                .get_user(user_id)
                .map(|u| u.display_name.clone());
            guard.send_host(&RelayToHost::CollabInput {
                user_id: user_id.to_string(),
                display_name,
                content,
            });
        }

        ClientMessage::HostPromote { user_id: target } => {
            let mut guard = state.write().await;
            if !guard.access.is_admin(user_id) {
                return;
            }
            if guard.access.set_role(&target, UserRole::Edit) {
                guard.broadcast_active(&ServerMessage::UserRoleChanged {
                    user_id: target,
                    role: UserRole::Edit,
                });
            }
        }

        ClientMessage::HostDemote { user_id: target } => {
            let mut guard = state.write().await;
            if !guard.access.is_admin(user_id) {
                return;
            }
            if guard.access.set_role(&target, UserRole::View) {
                guard.broadcast_active(&ServerMessage::UserRoleChanged {
                    user_id: target,
                    role: UserRole::View,
                });
            }
        }

        ClientMessage::HostKick { user_id: target } => {
            let guard = state.read().await;
            if !guard.access.is_admin(user_id) {
                return;
            }
            if let Some(target_tx) = guard.clients.get(&target) {
                let _ = target_tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: axum::extract::ws::CloseCode::from(4003u16),
                    reason: "kicked by host".into(),
                })));
            }
        }

        ClientMessage::HostClose => {
            let mut guard = state.write().await;
            if !guard.access.is_admin(user_id) {
                return;
            }
            guard.broadcast_all_clients(&ServerMessage::SessionClosed);
            guard.running = false;
            for ctx in guard.clients.values() {
                let _ = ctx.send(Message::Close(None));
            }
        }

        ClientMessage::Auth { .. } => {}
    }
}

async fn handle_host(socket: WebSocket, state: SharedState, host_token: Arc<String>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx): (HostTx, _) = mpsc::unbounded_channel();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut authed = false;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: HostToRelay = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => {
                let _ = tx.send(text_msg_host(&RelayToHost::Error {
                    code: "BAD_MESSAGE".into(),
                    message: "Invalid JSON".into(),
                }));
                continue;
            }
        };

        match parsed {
            HostToRelay::HostAuth { token } => {
                if token != *host_token {
                    let _ = tx.send(text_msg_host(&RelayToHost::Error {
                        code: "AUTH_FAILED".into(),
                        message: "Invalid host token".into(),
                    }));
                    let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: axum::extract::ws::CloseCode::from(4001u16),
                        reason: "auth failed".into(),
                    })));
                    break;
                }
                {
                    let mut guard = state.write().await;
                    guard.host = Some(tx.clone());
                    let port = guard.port;
                    let users = guard.access.list_users();
                    let _ = tx.send(text_msg_host(&RelayToHost::HostReady { port }));
                    let _ = tx.send(text_msg_host(&RelayToHost::UserList { users }));
                }
                authed = true;
            }

            other if !authed => {
                let _ = tx.send(text_msg_host(&RelayToHost::Error {
                    code: "NOT_AUTHED".into(),
                    message: "Send host.auth first".into(),
                }));
                let _ = other;
            }

            HostToRelay::TokenIssue {
                session_id,
                role,
                ttl_ms,
            } => {
                let mut guard = state.write().await;
                let role = role.unwrap_or(UserRole::Edit);
                let st = guard.access.issue_token(&session_id, role, ttl_ms);
                let _ = tx.send(text_msg_host(&RelayToHost::TokenIssued { token: st }));
            }

            HostToRelay::SessionPolicy {
                require_approval,
                repo_remote,
                allowed_email_domain,
                additional_repo_remote_prefixes,
                repo_remote_rewrites,
            } => {
                let mut guard = state.write().await;
                if let Some(v) = require_approval {
                    guard.policy.require_approval = v;
                }
                if let Some(prefixes) = additional_repo_remote_prefixes {
                    guard.policy.additional_repo_remote_prefixes =
                        sanitize_repo_remote_prefixes(&prefixes);
                }
                if let Some(rewrites) = repo_remote_rewrites {
                    guard.policy.repo_remote_rewrites = sanitize_repo_remote_rewrites(&rewrites);
                }
                if let Some(raw) = repo_remote {
                    let normalized = guard.policy.normalize_remote(&raw);
                    guard.policy.repo_remote = if normalized.is_empty() {
                        None
                    } else {
                        Some(normalized)
                    };
                }
                if let Some(raw) = allowed_email_domain {
                    let normalized = raw.trim().trim_start_matches('@').to_ascii_lowercase();
                    guard.policy.allowed_email_domain = if normalized.is_empty() {
                        None
                    } else {
                        Some(normalized)
                    };
                }
            }

            HostToRelay::SessionEvent { event } => {
                let mut guard = state.write().await;
                guard.event_history.push(event.clone());
                guard.broadcast_active(&ServerMessage::SessionEvent { event });
            }

            HostToRelay::ChatSend {
                content,
                display_name,
            } => {
                let mut guard = state.write().await;
                let chat = ChatMessage {
                    id: random_hex(8),
                    session_id: String::new(),
                    user_id: "host".into(),
                    display_name,
                    content,
                    timestamp: now_ms(),
                };
                guard.chat_history.push(chat.clone());
                guard.broadcast_active(&ServerMessage::ChatMessage {
                    message: chat.clone(),
                });
                let _ = tx.send(text_msg_host(&RelayToHost::ChatMessage { message: chat }));
            }

            HostToRelay::HostPromote { user_id } => {
                let mut guard = state.write().await;
                if guard.access.set_role(&user_id, UserRole::Edit) {
                    guard.broadcast_active(&ServerMessage::UserRoleChanged {
                        user_id,
                        role: UserRole::Edit,
                    });
                }
            }

            HostToRelay::HostDemote { user_id } => {
                let mut guard = state.write().await;
                if guard.access.set_role(&user_id, UserRole::View) {
                    guard.broadcast_active(&ServerMessage::UserRoleChanged {
                        user_id,
                        role: UserRole::View,
                    });
                }
            }

            HostToRelay::HostKick { user_id } => {
                let guard = state.read().await;
                if let Some(target_tx) = guard.clients.get(&user_id) {
                    let _ = target_tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: axum::extract::ws::CloseCode::from(4003u16),
                        reason: "kicked by host".into(),
                    })));
                }
            }

            HostToRelay::HostApprove { user_id } => {
                let mut guard = state.write().await;
                if let Some(user) = guard.access.approve(&user_id) {
                    if let Some(tx) = guard.clients.get(&user_id).cloned() {
                        admit_active(&mut guard, &user_id, &user, &tx);
                    }
                }
            }

            HostToRelay::HostDeny { user_id } => {
                let guard = state.read().await;
                if guard.access.is_pending(&user_id) {
                    if let Some(target_tx) = guard.clients.get(&user_id) {
                        let _ = target_tx.send(text_msg(&ServerMessage::AuthDenied {
                            message: "Host denied your join request".into(),
                        }));
                        let _ = target_tx.send(Message::Close(Some(
                            axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::CloseCode::from(4005u16),
                                reason: "denied by host".into(),
                            },
                        )));
                    }
                }
            }

            HostToRelay::HostClose => {
                let mut guard = state.write().await;
                guard.broadcast_all_clients(&ServerMessage::SessionClosed);
                for ctx in guard.clients.values() {
                    let _ = ctx.send(Message::Close(None));
                }
                guard.clients.clear();
                guard.access = AccessManager::new();
                guard.event_history.clear();
                guard.chat_history.clear();
                guard.policy = SessionPolicy::default();
                guard.running = false;
            }

            HostToRelay::StatusGet => {
                let guard = state.read().await;
                let _ = tx.send(text_msg_host(&RelayToHost::Status {
                    clients: guard.client_count(),
                    running: guard.running,
                    policy: Some(guard.policy.clone()),
                }));
            }
        }
    }

    {
        let mut guard = state.write().await;
        guard.host = None;
    }
    drop(tx);
    let _ = writer.await;
}

fn text_msg(msg: &ServerMessage) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default().into())
}

fn text_msg_host(msg: &RelayToHost) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default().into())
}
