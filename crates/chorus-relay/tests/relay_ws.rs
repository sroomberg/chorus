use chorus_relay::protocol::{
    ClientMessage, HostToRelay, RelayToHost, RepoRemoteRewrite, ServerMessage, SessionEvent,
    UserRole,
};
use chorus_relay::server::{serve, RelayConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn start_relay(port: u16, host_token: &str) {
    let token = host_token.to_string();
    tokio::spawn(async move {
        serve(RelayConfig {
            port,
            host_token: token,
            bind: "127.0.0.1".into(),
        })
        .await
        .expect("relay failed");
    });
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("relay did not become ready on port {port}");
}

async fn connect_host(port: u16, host_token: &str) -> WsStream {
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/host"))
        .await
        .expect("host connect");
    ws.send(Message::Text(
        serde_json::to_string(&HostToRelay::HostAuth {
            token: host_token.into(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let msg = recv_json::<RelayToHost>(&mut ws).await;
    assert!(matches!(msg, RelayToHost::HostReady { .. }));
    // optional user.list
    let _ = tokio::time::timeout(Duration::from_millis(100), ws.next()).await;
    ws
}

async fn recv_json<T: serde::de::DeserializeOwned>(ws: &mut WsStream) -> T {
    loop {
        let msg = ws.next().await.expect("stream ended").expect("ws error");
        match msg {
            Message::Text(t) => return serde_json::from_str(&t).expect("json"),
            Message::Close(frame) => panic!("unexpected close: {frame:?}"),
            _ => continue,
        }
    }
}

async fn wait_for_server<F>(ws: &mut WsStream, mut pred: F) -> ServerMessage
where
    F: FnMut(&ServerMessage) -> bool,
{
    for _ in 0..20 {
        let msg = recv_json::<ServerMessage>(ws).await;
        if pred(&msg) {
            return msg;
        }
    }
    panic!("timed out waiting for expected server message");
}

async fn wait_for_host<F>(ws: &mut WsStream, mut pred: F) -> RelayToHost
where
    F: FnMut(&RelayToHost) -> bool,
{
    for _ in 0..20 {
        let msg = recv_json::<RelayToHost>(ws).await;
        if pred(&msg) {
            return msg;
        }
    }
    panic!("timed out waiting for expected host message");
}

async fn issue_token(host: &mut WsStream, role: UserRole) -> String {
    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::TokenIssue {
            session_id: "sess-1".into(),
            role: Some(role),
            ttl_ms: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let msg = wait_for_host(host, |m| matches!(m, RelayToHost::TokenIssued { .. })).await;
    match msg {
        RelayToHost::TokenIssued { token } => token.token,
        _ => unreachable!(),
    }
}

async fn join_authed(port: u16, token: String) -> WsStream {
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "joiner".into(),
            repo_remote: None,
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _ = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::SessionHistory { .. })).await;
    let _ = wait_for_server(&mut ws, |m| {
        matches!(
            m,
            ServerMessage::UserList { .. } | ServerMessage::UserJoined { .. }
        )
    })
    .await;
    ws
}

#[tokio::test]
async fn rejects_invalid_joiner_token() {
    let port = 18742;
    start_relay(port, "secret").await;

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token: "bad".into(),
            display_name: "X".into(),
            repo_remote: None,
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw_auth_failed = false;
    let mut close_code = None;
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(ServerMessage::Error { code, .. }) = serde_json::from_str(&t) {
                    if code == "AUTH_FAILED" {
                        saw_auth_failed = true;
                    }
                }
            }
            Message::Close(frame) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            _ => {}
        }
    }
    // Either the error frame or the 4001 close is sufficient — some WS stacks
    // coalesce the close before the text is observed.
    assert!(saw_auth_failed || close_code == Some(4001));
}

#[tokio::test]
async fn accepts_valid_token_and_sends_history() {
    let port = 18743;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;
    let token = issue_token(&mut host, UserRole::Edit).await;

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "Alice".into(),
            repo_remote: None,
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let _ = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::SessionHistory { .. })).await;
    let _ = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::UserList { .. })).await;
}

#[tokio::test]
async fn broadcasts_session_events() {
    let port = 18744;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;
    let t1 = issue_token(&mut host, UserRole::Edit).await;
    let t2 = issue_token(&mut host, UserRole::Edit).await;

    let mut c1 = join_authed(port, t1).await;
    let mut c2 = join_authed(port, t2).await;

    // Drain the user.joined notification that c2 caused on c1.
    let _ = tokio::time::timeout(Duration::from_millis(150), async {
        loop {
            let msg = recv_json::<ServerMessage>(&mut c1).await;
            if matches!(msg, ServerMessage::UserJoined { .. }) {
                break;
            }
        }
    })
    .await;

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::SessionEvent {
            event: SessionEvent {
                id: "e1".into(),
                session_id: "sess-1".into(),
                event_type: "message.created".into(),
                payload: json!("hello"),
                timestamp: 1,
            },
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let m1 = wait_for_server(&mut c1, |m| matches!(m, ServerMessage::SessionEvent { .. })).await;
    let m2 = wait_for_server(&mut c2, |m| matches!(m, ServerMessage::SessionEvent { .. })).await;
    assert!(matches!(m1, ServerMessage::SessionEvent { .. }));
    assert!(matches!(m2, ServerMessage::SessionEvent { .. }));
}

#[tokio::test]
async fn forwards_collab_input_to_host() {
    let port = 18745;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;
    let token = issue_token(&mut host, UserRole::Edit).await;

    let mut ws = join_authed(port, token).await;
    let _ = tokio::time::timeout(Duration::from_millis(150), async {
        loop {
            let msg = recv_json::<RelayToHost>(&mut host).await;
            if matches!(msg, RelayToHost::UserJoined { .. }) {
                break;
            }
        }
    })
    .await;

    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::CollabInput {
            content: "refactor this".into(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let msg = wait_for_host(&mut host, |m| matches!(m, RelayToHost::CollabInput { .. })).await;
    match msg {
        RelayToHost::CollabInput { content, .. } => assert_eq!(content, "refactor this"),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn requires_display_name() {
    let port = 18746;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;
    let token = issue_token(&mut host, UserRole::Edit).await;

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "   ".into(),
            repo_remote: None,
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw_name = false;
    let mut close_code = None;
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(ServerMessage::Error { code, .. }) = serde_json::from_str(&t) {
                    if code == "NAME_REQUIRED" {
                        saw_name = true;
                    }
                }
            }
            Message::Close(frame) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            _ => {}
        }
    }
    assert!(saw_name || close_code == Some(4002));
}

#[tokio::test]
async fn pending_until_host_approves() {
    let port = 18747;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::SessionPolicy {
            require_approval: Some(true),
            repo_remote: None,
            allowed_email_domain: None,
            additional_repo_remote_prefixes: None,
            repo_remote_rewrites: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let token = issue_token(&mut host, UserRole::Edit).await;
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "Pat".into(),
            repo_remote: None,
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let pending = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::AuthPending { .. })).await;
    let user_id = match pending {
        ServerMessage::AuthPending { user_id, .. } => user_id,
        _ => unreachable!(),
    };

    let host_pending =
        wait_for_host(&mut host, |m| matches!(m, RelayToHost::UserPending { .. })).await;
    assert!(matches!(host_pending, RelayToHost::UserPending { .. }));

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::HostApprove {
            user_id: user_id.clone(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let _ = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::SessionHistory { .. })).await;
}

#[tokio::test]
async fn rejects_mismatched_repo_remote() {
    let port = 18748;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::SessionPolicy {
            require_approval: Some(false),
            repo_remote: Some("https://github.com/acme/app.git".into()),
            allowed_email_domain: None,
            additional_repo_remote_prefixes: None,
            repo_remote_rewrites: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let token = issue_token(&mut host, UserRole::Edit).await;
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "Eve".into(),
            repo_remote: Some("https://github.com/other/repo.git".into()),
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw = false;
    let mut close_code = None;
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(ServerMessage::Error { code, .. }) = serde_json::from_str(&t) {
                    if code == "REPO_ACCESS_DENIED" {
                        saw = true;
                    }
                }
            }
            Message::Close(frame) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            _ => {}
        }
    }
    assert!(saw || close_code == Some(4004));
}

#[tokio::test]
async fn rejects_mismatched_email_domain() {
    let port = 18749;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::SessionPolicy {
            require_approval: Some(false),
            repo_remote: None,
            allowed_email_domain: Some("acme.com".into()),
            additional_repo_remote_prefixes: None,
            repo_remote_rewrites: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let token = issue_token(&mut host, UserRole::Edit).await;
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "Eve".into(),
            repo_remote: None,
            email: Some("eve@other.com".into()),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw = false;
    let mut close_code = None;
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(ServerMessage::Error { code, .. }) = serde_json::from_str(&t) {
                    if code == "EMAIL_ACCESS_DENIED" {
                        saw = true;
                    }
                }
            }
            Message::Close(frame) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            _ => {}
        }
    }
    assert!(saw || close_code == Some(4007));
}

#[tokio::test]
async fn accepts_custom_remote_format_with_policy_prefix_and_rewrite() {
    let port = 18750;
    start_relay(port, "secret").await;
    let mut host = connect_host(port, "secret").await;

    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::SessionPolicy {
            require_approval: Some(false),
            repo_remote: Some("https://github.com/acme/app.git".into()),
            allowed_email_domain: None,
            additional_repo_remote_prefixes: Some(vec!["git://".into()]),
            repo_remote_rewrites: Some(vec![RepoRemoteRewrite {
                from: "github.acme.com".into(),
                to: "github.com".into(),
            }]),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let token = issue_token(&mut host, UserRole::Edit).await;
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientMessage::Auth {
            token,
            display_name: "Dev".into(),
            repo_remote: Some("git://github.acme.com/acme/app.git".into()),
            email: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let _ = wait_for_server(&mut ws, |m| matches!(m, ServerMessage::SessionHistory { .. })).await;
}
