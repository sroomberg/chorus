//! Minimal stdio MCP server exposing Chorus join tools to Zed's Agent Panel.

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::runtime::Handle;
use tokio::sync::Mutex;

use crate::client::{JoinClient, JoinStatus};
use crate::host::{
    format_share_status, parse_role, HostSession, LiveSession, ShareOpts,
};

struct Session {
    live: LiveSession,
}

/// Run an MCP server on stdin/stdout (blocking; requires a Tokio handle).
pub fn run_stdio(handle: Handle) -> Result<(), String> {
    let session = Arc::new(Mutex::new(Session {
        live: LiveSession::Idle,
    }));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());

    loop {
        let msg = match read_message(&mut reader)? {
            Some(v) => v,
            None => break,
        };

        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));

        // Notifications (no id) — ignore after handling initialize side-effects if any.
        if id.is_none() {
            continue;
        }

        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "chorus-zed",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })),
            "tools/list" => Ok(json!({ "tools": tool_defs() })),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                handle.block_on(call_tool(session.clone(), name, args))
            }
            "ping" => Ok(json!({})),
            _ => Err(format!("method not found: {method}")),
        };

        let response = match result {
            Ok(value) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": value
            }),
            Err(err) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": err }
            }),
        };
        write_message(&mut stdout, &response)?;
    }
    Ok(())
}

fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "chorus_join",
            "description": "Join an existing Chorus collaborative session as a joiner (connect to relay /ws).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "host": {
                        "type": "string",
                        "description": "Relay host:port (e.g. 192.168.1.10:7742) or full ws:// URL"
                    },
                    "token": { "type": "string", "description": "Join token from the host" },
                    "display_name": {
                        "type": "string",
                        "description": "Required display name shown to collaborators"
                    },
                    "repo_remote": {
                        "type": "string",
                        "description": "Optional git remote URL when the host enabled a same-repo gate"
                    },
                    "email": {
                        "type": "string",
                        "description": "Optional email when the host enabled an allowedEmailDomain gate"
                    }
                },
                "required": ["host", "token", "display_name"]
            }
        }),
        json!({
            "name": "chorus_leave",
            "description": "Leave the current Chorus session and disconnect from the relay.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "chorus_chat",
            "description": "Send a side-channel chat message (does not become an LLM prompt).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "Chat message text" }
                },
                "required": ["content"]
            }
        }),
        json!({
            "name": "chorus_prompt",
            "description": "Send a collaborative prompt (collab.input) into the host OpenCode session. Requires edit role.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "Prompt text for the host session" }
                },
                "required": ["content"]
            }
        }),
        json!({
            "name": "chorus_status",
            "description": "Show join or share status, users, pending joiners, and recent events.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "chorus_share",
            "description": "Host a Chorus session: start chorus-relay, set access policy, and return a /chorus-join command. Does not drive an OpenCode LLM loop; joiner prompts appear in chorus_status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "number",
                        "description": "Relay listen port (default 7742)"
                    },
                    "role": {
                        "type": "string",
                        "description": "Join-token role: edit (default), view, or admin"
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Host display name shown to collaborators"
                    },
                    "require_approval": {
                        "type": "boolean",
                        "description": "Hold joiners pending until chorus_approve (default true)"
                    },
                    "repo_remote": {
                        "type": "string",
                        "description": "Optional origin URL for the same-repo gate (defaults to git origin)"
                    },
                    "allowed_email_domain": {
                        "type": "string",
                        "description": "Optional email domain gate (e.g. acme.com)"
                    },
                    "public_host": {
                        "type": "string",
                        "description": "Advertised host:port in the join command (defaults to LAN IP:port)"
                    }
                }
            }
        }),
        json!({
            "name": "chorus_stop",
            "description": "Stop hosting and tear down the local chorus-relay.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "chorus_approve",
            "description": "Approve a pending joiner by user_id (from chorus_status pending list).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "user_id": { "type": "string", "description": "Pending joiner userId" }
                },
                "required": ["user_id"]
            }
        }),
        json!({
            "name": "chorus_deny",
            "description": "Deny a pending joiner by user_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "user_id": { "type": "string", "description": "Pending joiner userId" }
                },
                "required": ["user_id"]
            }
        }),
        json!({
            "name": "chorus_publish",
            "description": "Fan out a host/AI line to joiners (session.event). Use while sharing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "Message text" },
                    "type": {
                        "type": "string",
                        "description": "user (default) or assistant"
                    }
                },
                "required": ["content"]
            }
        }),
    ]
}

async fn call_tool(
    session: Arc<Mutex<Session>>,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    match name {
        "chorus_join" => {
            let host = args
                .get("host")
                .and_then(|v| v.as_str())
                .ok_or("host is required")?
                .to_string();
            let token = args
                .get("token")
                .and_then(|v| v.as_str())
                .ok_or("token is required")?
                .to_string();
            let display_name = args
                .get("display_name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("display_name is required and must be non-empty")?
                .to_string();
            let repo_remote = args
                .get("repo_remote")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let email = args
                .get("email")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());

            let guard = session.lock().await;
            if matches!(guard.live, LiveSession::Sharing(_)) {
                return Err("stop sharing (chorus_stop) before joining another session".into());
            }
            drop(guard);

            let client =
                JoinClient::connect(&host, &token, &display_name, repo_remote, email).await?;
            let snap = client.snapshot().await;
            let mut guard = session.lock().await;
            if matches!(guard.live, LiveSession::Sharing(_)) {
                client.disconnect().await;
                return Err("stop sharing (chorus_stop) before joining another session".into());
            }
            guard.live.shutdown().await;
            guard.live = LiveSession::Joined(client);
            Ok(tool_text(format!(
                "Joined Chorus session on {} as {} (status={:?}, users={})",
                snap.host,
                snap.display_name,
                snap.status,
                snap.users.len()
            )))
        }
        "chorus_leave" => {
            let mut guard = session.lock().await;
            match std::mem::replace(&mut guard.live, LiveSession::Idle) {
                LiveSession::Joined(client) => {
                    client.disconnect().await;
                    Ok(tool_text("Left Chorus session.".into()))
                }
                LiveSession::Sharing(host) => {
                    host.stop().await;
                    Ok(tool_text("Stopped sharing (use chorus_stop next time).".into()))
                }
                LiveSession::Idle => Ok(tool_text("Not connected.".into())),
            }
        }
        "chorus_chat" => {
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content is required")?;
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Joined(client) => {
                    client.send_chat(content)?;
                    Ok(tool_text(format!("Chat sent: {content}")))
                }
                LiveSession::Sharing(host) => {
                    host.send_chat_named(content).await?;
                    Ok(tool_text(format!("Host chat sent: {content}")))
                }
                LiveSession::Idle => Err("not connected — call chorus_join or chorus_share first".into()),
            }
        }
        "chorus_prompt" => {
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content is required")?;
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Joined(client) => {
                    client.send_prompt(content)?;
                    Ok(tool_text(format!("Prompt forwarded to host: {content}")))
                }
                LiveSession::Sharing(_) => Err(
                    "you are hosting — joiners send prompts; use chorus_publish to fan out host/AI lines"
                        .into(),
                ),
                LiveSession::Idle => Err("not connected — call chorus_join first".into()),
            }
        }
        "chorus_status" => {
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Idle => Ok(tool_text(
                    "status: idle\n(no active Chorus join or share)".into(),
                )),
                LiveSession::Joined(client) => {
                    let snap = client.snapshot().await;
                    Ok(tool_text(format_status(&snap)))
                }
                LiveSession::Sharing(host) => {
                    let snap = host.snapshot().await;
                    Ok(tool_text(format_share_status(&snap)))
                }
            }
        }
        "chorus_share" => {
            let port = args
                .get("port")
                .and_then(|v| v.as_u64())
                .map(|n| n as u16)
                .unwrap_or(7742);
            let role = args
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("edit");
            let display_name = args
                .get("display_name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    std::env::var("CHORUS_DISPLAY_NAME")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| std::env::var("USER").ok())
                        .unwrap_or_else(|| "Zed".into())
                });
            let require_approval = args
                .get("require_approval")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let repo_remote = args
                .get("repo_remote")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let allowed_email_domain = args
                .get("allowed_email_domain")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let public_host = args
                .get("public_host")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            let host = HostSession::start(ShareOpts {
                port,
                role: parse_role(role)?,
                display_name,
                require_approval,
                repo_remote,
                allowed_email_domain,
                public_host,
            })
            .await?;
            let snap = host.snapshot().await;
            let mut guard = session.lock().await;
            guard.live.shutdown().await;
            guard.live = LiveSession::Sharing(host);
            Ok(tool_text(format!(
                "Sharing on {} (approval={}). Collaborator command:\n{}",
                snap.host, snap.require_approval, snap.join_command
            )))
        }
        "chorus_stop" => {
            let mut guard = session.lock().await;
            match std::mem::replace(&mut guard.live, LiveSession::Idle) {
                LiveSession::Sharing(host) => {
                    host.stop().await;
                    Ok(tool_text("Stopped sharing.".into()))
                }
                LiveSession::Joined(client) => {
                    client.disconnect().await;
                    Ok(tool_text("Left session (was joined, not sharing).".into()))
                }
                LiveSession::Idle => Ok(tool_text("Not sharing.".into())),
            }
        }
        "chorus_approve" => {
            let user_id = args
                .get("user_id")
                .and_then(|v| v.as_str())
                .ok_or("user_id is required")?;
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Sharing(host) => {
                    host.approve(user_id)?;
                    Ok(tool_text(format!("Approved {user_id}")))
                }
                _ => Err("share a session first (chorus_share)".into()),
            }
        }
        "chorus_deny" => {
            let user_id = args
                .get("user_id")
                .and_then(|v| v.as_str())
                .ok_or("user_id is required")?;
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Sharing(host) => {
                    host.deny(user_id)?;
                    Ok(tool_text(format!("Denied {user_id}")))
                }
                _ => Err("share a session first (chorus_share)".into()),
            }
        }
        "chorus_publish" => {
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content is required")?;
            let event_type = args
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("user");
            let guard = session.lock().await;
            match &guard.live {
                LiveSession::Sharing(host) => {
                    host.publish(content, event_type).await?;
                    Ok(tool_text(format!("Published {event_type} line: {content}")))
                }
                _ => Err("share a session first (chorus_share)".into()),
            }
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn tool_text(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

pub fn format_status(snap: &crate::client::SessionSnapshot) -> String {
    let mut out = String::new();
    out.push_str(&format!("status: {:?}\n", snap.status));
    out.push_str(&format!("host: {}\n", snap.host));
    out.push_str(&format!("displayName: {}\n", snap.display_name));
    if let Some(id) = &snap.session_id {
        out.push_str(&format!("sessionId: {id}\n"));
    }
    if let Some(err) = &snap.last_error {
        out.push_str(&format!("error: {err}\n"));
    }
    out.push_str(&format!("users ({})", snap.users.len()));
    if snap.users.is_empty() {
        out.push('\n');
    } else {
        out.push('\n');
        for u in &snap.users {
            out.push_str(&format!(
                "  - {} [{}] {:?} ({:?})\n",
                u.display_name, u.user_id, u.role, u.status
            ));
        }
    }
    out.push_str(&format!(
        "recentEvents: {} | recentChat: {}\n",
        snap.recent_events.len(),
        snap.recent_chat.len()
    ));
    if snap.status == JoinStatus::Connected || snap.status == JoinStatus::Pending {
        for chat in snap.recent_chat.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev()
        {
            let name = chat.display_name.as_deref().unwrap_or(&chat.user_id);
            out.push_str(&format!("  chat <{name}> {}\n", chat.content));
        }
    }
    out
}

fn read_message<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("stdin read: {e}"))?;
        if n == 0 {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        headers.push_str(&line);
    }

    let mut content_length: Option<usize> = None;
    for header in headers.lines() {
        let lower = header.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().ok();
        }
    }
    let len = content_length.ok_or("missing Content-Length")?;
    let mut buf = vec![0u8; len];
    reader
        .read_exact(&mut buf)
        .map_err(|e| format!("body read: {e}"))?;
    let value = serde_json::from_slice(&buf).map_err(|e| format!("json: {e}"))?;
    Ok(Some(value))
}

fn write_message<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    writer.write_all(&body).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}
