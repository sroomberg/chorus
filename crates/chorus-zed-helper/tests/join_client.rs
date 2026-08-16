//! Integration: JoinClient against a live chorus-relay (auth, chat, collab.input).

use std::time::Duration;

use chorus_relay::protocol::{HostToRelay, RelayToHost, UserRole};
use chorus_relay::server::{serve, RelayConfig};
use chorus_zed_helper::client::{JoinClient, JoinStatus};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
    panic!("relay not ready on {port}");
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
    let _ = tokio::time::timeout(Duration::from_millis(100), ws.next()).await;
    ws
}

async fn recv_json<T: serde::de::DeserializeOwned>(ws: &mut WsStream) -> T {
    loop {
        let msg = ws.next().await.expect("ended").expect("ws");
        match msg {
            Message::Text(t) => return serde_json::from_str(&t).expect("json"),
            Message::Close(frame) => panic!("close: {frame:?}"),
            _ => continue,
        }
    }
}

async fn issue_token(host: &mut WsStream) -> String {
    host.send(Message::Text(
        serde_json::to_string(&HostToRelay::TokenIssue {
            session_id: "sess-zed".into(),
            role: Some(UserRole::Edit),
            ttl_ms: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let msg = recv_json::<RelayToHost>(host).await;
        if let RelayToHost::TokenIssued { token } = msg {
            return token.token;
        }
    }
}

#[tokio::test]
async fn join_client_auth_chat_and_prompt() {
    let port = 17942;
    let host_token = "zed-helper-test-token";
    start_relay(port, host_token).await;
    let mut host = connect_host(port, host_token).await;
    let token = issue_token(&mut host).await;

    let client = JoinClient::connect(&format!("127.0.0.1:{port}"), &token, "ZedTester")
        .await
        .expect("join");
    let snap = client.snapshot().await;
    assert_eq!(snap.status, JoinStatus::Connected);

    client.send_chat("hello from zed helper").unwrap();
    // Host should receive chat.message
    let mut saw_chat = false;
    for _ in 0..20 {
        let msg = recv_json::<RelayToHost>(&mut host).await;
        if let RelayToHost::ChatMessage { message } = msg {
            assert_eq!(message.content, "hello from zed helper");
            saw_chat = true;
            break;
        }
    }
    assert!(saw_chat, "host did not receive chat");

    client.send_prompt("fix the bug").unwrap();
    let mut saw_prompt = false;
    for _ in 0..20 {
        let msg = recv_json::<RelayToHost>(&mut host).await;
        if let RelayToHost::CollabInput { content, .. } = msg {
            assert_eq!(content, "fix the bug");
            saw_prompt = true;
            break;
        }
    }
    assert!(saw_prompt, "host did not receive collab.input");

    client.disconnect().await;
}
