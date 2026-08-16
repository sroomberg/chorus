//! Minimal stdio MCP server exposing Chorus join tools to Zed's Agent Panel.

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::runtime::Handle;
use tokio::sync::Mutex;

use crate::client::{JoinClient, JoinStatus};

struct Session {
    client: Option<JoinClient>,
}

/// Run an MCP server on stdin/stdout (blocking; requires a Tokio handle).
pub fn run_stdio(handle: Handle) -> Result<(), String> {
    let session = Arc::new(Mutex::new(Session { client: None }));
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
                        "description": "Display name shown to collaborators (default: Zed)"
                    }
                },
                "required": ["host", "token"]
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
            "description": "Show join connection status, users, and recent session/chat events.",
            "inputSchema": { "type": "object", "properties": {} }
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
                .unwrap_or("Zed")
                .to_string();

            let client = JoinClient::connect(&host, &token, &display_name).await?;
            let snap = client.snapshot().await;
            let mut guard = session.lock().await;
            if let Some(old) = guard.client.take() {
                old.disconnect().await;
            }
            guard.client = Some(client);
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
            if let Some(client) = guard.client.take() {
                client.disconnect().await;
                Ok(tool_text("Left Chorus session.".into()))
            } else {
                Ok(tool_text("Not connected.".into()))
            }
        }
        "chorus_chat" => {
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content is required")?;
            let guard = session.lock().await;
            let client = guard.client.as_ref().ok_or("not connected — call chorus_join first")?;
            client.send_chat(content)?;
            Ok(tool_text(format!("Chat sent: {content}")))
        }
        "chorus_prompt" => {
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content is required")?;
            let guard = session.lock().await;
            let client = guard.client.as_ref().ok_or("not connected — call chorus_join first")?;
            client.send_prompt(content)?;
            Ok(tool_text(format!("Prompt forwarded to host: {content}")))
        }
        "chorus_status" => {
            let guard = session.lock().await;
            match guard.client.as_ref() {
                None => Ok(tool_text(
                    "status: disconnected\n(no active Chorus join)".into(),
                )),
                Some(client) => {
                    let snap = client.snapshot().await;
                    Ok(tool_text(format_status(&snap)))
                }
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
            let name = u.display_name.as_deref().unwrap_or("(anonymous)");
            out.push_str(&format!("  - {} [{}] {:?}\n", name, u.user_id, u.role));
        }
    }
    out.push_str(&format!(
        "recentEvents: {} | recentChat: {}\n",
        snap.recent_events.len(),
        snap.recent_chat.len()
    ));
    if snap.status == JoinStatus::Connected {
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
