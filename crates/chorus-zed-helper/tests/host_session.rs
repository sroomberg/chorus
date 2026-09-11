//! Integration: HostSession share → pending join → approve → collab.input.

use std::time::Duration;

use chorus_zed_helper::client::{JoinClient, JoinStatus};
use chorus_zed_helper::host::{HostSession, ShareOpts, parse_role};
use chorus_relay::protocol::UserRole;

#[tokio::test]
async fn share_pending_approve_and_prompt() {
    let port = 17944;
    let host = HostSession::start(ShareOpts {
        port,
        role: UserRole::Edit,
        display_name: "ZedHost".into(),
        require_approval: true,
        repo_remote: Some(String::new()),
        allowed_email_domain: None,
        public_host: Some(format!("127.0.0.1:{port}")),
    })
    .await
    .expect("share");

    let snap = host.snapshot().await;
    assert!(snap.sharing);
    assert!(snap.join_command.contains("token="));
    assert!(snap.join_command.contains(&format!("host=\"127.0.0.1:{port}\"")));

    let token = snap
        .join_command
        .split("token=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .expect("token")
        .to_string();

    let joiner = JoinClient::connect(
        &format!("127.0.0.1:{port}"),
        &token,
        "ZedGuest",
        None,
        None,
    )
    .await
    .expect("join");
    assert_eq!(joiner.snapshot().await.status, JoinStatus::Pending);

    let mut user_id = String::new();
    for _ in 0..40 {
        let pending = host.snapshot().await.pending_users;
        if let Some(u) = pending.first() {
            user_id = u.user_id.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!user_id.is_empty(), "host never saw pending joiner");
    host.approve(&user_id).unwrap();

    for _ in 0..40 {
        if joiner.snapshot().await.status == JoinStatus::Connected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(joiner.snapshot().await.status, JoinStatus::Connected);

    joiner.send_prompt("from-guest").unwrap();
    let mut saw = false;
    for _ in 0..40 {
        if host
            .snapshot()
            .await
            .recent_inputs
            .iter()
            .any(|l| l.contains("from-guest"))
        {
            saw = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(saw, "host did not record collab.input");

    joiner.disconnect().await;
    host.stop().await;
}

#[test]
fn role_helper() {
    assert_eq!(parse_role("edit").unwrap(), UserRole::Edit);
}
