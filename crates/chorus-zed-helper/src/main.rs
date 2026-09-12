use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use clap::{Parser, Subcommand};
use chorus_zed_helper::client::JoinClient;
use chorus_zed_helper::control::{
    pid_path, runtime_dir, socket_path, ControlRequest, ControlResponse,
};
use chorus_zed_helper::host::{
    format_share_status, parse_role, HostSession, LiveSession, ShareOpts,
};
use chorus_zed_helper::mcp::{self, format_status};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

#[derive(Parser, Debug)]
#[command(
    name = "chorus-zed-helper",
    about = "Chorus join/host client for Zed (CLI + MCP)."
)]
struct Args {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Start the background daemon that holds the WebSocket session
    Daemon,
    /// Connect to a Chorus relay as a joiner
    Join {
        /// Relay host:port (e.g. 192.168.1.10:7742) or ws:// URL
        #[arg(long, env = "CHORUS_RELAY_HOST")]
        host: String,
        /// Join token from the host share command
        #[arg(long)]
        token: String,
        /// Display name shown to collaborators (required non-empty)
        #[arg(long, default_value = "Zed", env = "CHORUS_DISPLAY_NAME")]
        name: String,
        /// Optional git remote when the host enabled a same-repo gate
        #[arg(long, env = "CHORUS_REPO_REMOTE")]
        repo_remote: Option<String>,
        /// Optional email when the host enabled an allowedEmailDomain gate
        #[arg(long, env = "CHORUS_EMAIL")]
        email: Option<String>,
    },
    /// Disconnect from the current joined session
    Leave,
    /// Host a session (spawn relay, issue join token)
    Share {
        /// Relay listen port
        #[arg(long, default_value_t = 7742, env = "CHORUS_PORT")]
        port: u16,
        /// Join-token role: edit, view, or admin
        #[arg(long, default_value = "edit")]
        role: String,
        /// Host display name
        #[arg(long, default_value = "Zed", env = "CHORUS_DISPLAY_NAME")]
        name: String,
        /// Auto-admit joiners (default is host approval required)
        #[arg(long, default_value_t = false)]
        auto_admit: bool,
        /// Optional git origin for the same-repo gate
        #[arg(long, env = "CHORUS_REPO_REMOTE")]
        repo_remote: Option<String>,
        /// Optional email domain gate
        #[arg(long)]
        allowed_email_domain: Option<String>,
        /// Advertised host:port in the join command
        #[arg(long, env = "CHORUS_PUBLIC_HOST")]
        public_host: Option<String>,
    },
    /// Stop hosting and tear down the local relay
    Stop,
    /// Approve a pending joiner
    Approve {
        user_id: String,
    },
    /// Deny a pending joiner
    Deny {
        user_id: String,
    },
    /// Publish a host/AI line to joiners
    Publish {
        content: String,
        #[arg(long, default_value = "user")]
        r#type: String,
    },
    /// Send a side-channel chat message
    Chat {
        /// Message text
        content: String,
    },
    /// Forward a prompt into the host session (`collab.input`)
    Prompt {
        /// Prompt text
        content: String,
    },
    /// Print connection status
    Status,
    /// Run as an MCP stdio server for Zed
    Mcp,
    /// Shut down the background daemon
    Shutdown,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();
    match args.command {
        Commands::Daemon => run_daemon().await?,
        Commands::Mcp => {
            let handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || mcp::run_stdio(handle))
                .await
                .map_err(|e| e.to_string())??;
        }
        Commands::Join {
            host,
            token,
            name,
            repo_remote,
            email,
        } => {
            ensure_daemon().await?;
            let resp = request(ControlRequest::Join {
                host,
                token,
                display_name: name,
                repo_remote,
                email,
            })
            .await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Share {
            port,
            role,
            name,
            auto_admit,
            repo_remote,
            allowed_email_domain,
            public_host,
        } => {
            ensure_daemon().await?;
            let resp = request(ControlRequest::Share {
                port: Some(port),
                role: Some(role),
                display_name: Some(name),
                require_approval: Some(!auto_admit),
                repo_remote,
                allowed_email_domain,
                public_host,
            })
            .await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Stop => {
            let resp = request(ControlRequest::Stop).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Approve { user_id } => {
            let resp = request(ControlRequest::Approve { user_id }).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Deny { user_id } => {
            let resp = request(ControlRequest::Deny { user_id }).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Publish { content, r#type } => {
            let resp = request(ControlRequest::Publish {
                content,
                event_type: Some(r#type),
            })
            .await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Leave => {
            let resp = request(ControlRequest::Leave).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Chat { content } => {
            let resp = request(ControlRequest::Chat { content }).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Prompt { content } => {
            let resp = request(ControlRequest::Prompt { content }).await?;
            print_response(&resp);
            if !resp.ok {
                std::process::exit(1);
            }
        }
        Commands::Status => match request(ControlRequest::Status).await {
            Ok(resp) => {
                print_response(&resp);
                if !resp.ok {
                    std::process::exit(1);
                }
            }
            Err(_) => {
                println!("status: idle\n(daemon not running)");
            }
        },
        Commands::Shutdown => match request(ControlRequest::Shutdown).await {
            Ok(resp) => print_response(&resp),
            Err(_) => println!("daemon not running"),
        },
    }
    Ok(())
}

fn print_response(resp: &ControlResponse) {
    if let Some(share) = &resp.share {
        print!("{}", format_share_status(share));
    } else if let Some(snap) = &resp.snapshot {
        print!("{}", format_status(snap));
    } else if let Some(msg) = &resp.message {
        println!("{msg}");
    } else if let Some(err) = &resp.error {
        eprintln!("error: {err}");
    } else if resp.ok {
        println!("ok");
    }
}

async fn ensure_daemon() -> Result<(), String> {
    if ping_daemon().await.is_ok() {
        return Ok(());
    }
    let dir = runtime_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let sock = socket_path();
    if sock.exists() {
        let _ = fs::remove_file(&sock);
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let child = Command::new(&exe)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn daemon: {e}"))?;

    fs::write(pid_path(), child.id().to_string()).map_err(|e| e.to_string())?;

    for _ in 0..50 {
        if ping_daemon().await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("daemon did not become ready".into())
}

async fn ping_daemon() -> Result<(), String> {
    let resp = request(ControlRequest::Ping).await?;
    if resp.ok {
        Ok(())
    } else {
        Err(resp.error.unwrap_or_else(|| "ping failed".into()))
    }
}

async fn request(req: ControlRequest) -> Result<ControlResponse, String> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("connect control socket: {e}"))?;
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(response.trim()).map_err(|e| format!("bad control response: {e}"))
}

async fn run_daemon() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    let dir = runtime_dir();
    fs::create_dir_all(&dir)?;
    let sock: PathBuf = socket_path();
    if sock.exists() {
        fs::remove_file(&sock)?;
    }

    let listener = UnixListener::bind(&sock)?;
    let session: Mutex<LiveSession> = Mutex::new(LiveSession::Idle);

    loop {
        let (stream, _) = listener.accept().await?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            continue;
        }
        let req: ControlRequest = match serde_json::from_str(line.trim()) {
            Ok(r) => r,
            Err(e) => {
                let mut stream = reader.into_inner();
                let resp = ControlResponse::err(format!("bad request: {e}"));
                let body = serde_json::to_string(&resp)?;
                stream.write_all(body.as_bytes()).await?;
                stream.write_all(b"\n").await?;
                continue;
            }
        };

        let (resp, shutdown) = handle_control(&session, req).await;
        let mut stream = reader.into_inner();
        let body = serde_json::to_string(&resp)?;
        stream.write_all(body.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        if shutdown {
            break;
        }
    }

    let _ = fs::remove_file(sock);
    let _ = fs::remove_file(pid_path());
    Ok(())
}

async fn handle_control(
    session: &Mutex<LiveSession>,
    req: ControlRequest,
) -> (ControlResponse, bool) {
    match req {
        ControlRequest::Ping => (ControlResponse::ok_msg("pong"), false),
        ControlRequest::Shutdown => {
            let mut guard = session.lock().await;
            guard.shutdown().await;
            (ControlResponse::ok_msg("shutting down"), true)
        }
        ControlRequest::Join {
            host,
            token,
            display_name,
            repo_remote,
            email,
        } => {
            {
                let guard = session.lock().await;
                if matches!(*guard, LiveSession::Sharing(_)) {
                    return (
                        ControlResponse::err("stop sharing before joining another session"),
                        false,
                    );
                }
            }
            match JoinClient::connect(
                &host,
                &token,
                &display_name,
                repo_remote.as_deref(),
                email.as_deref(),
            )
            .await
            {
                Ok(client) => {
                    let snap = client.snapshot().await;
                    let mut guard = session.lock().await;
                    guard.shutdown().await;
                    *guard = LiveSession::Joined(client);
                    (ControlResponse::ok_status(snap), false)
                }
                Err(e) => (ControlResponse::err(e), false),
            }
        }
        ControlRequest::Share {
            port,
            role,
            display_name,
            require_approval,
            repo_remote,
            allowed_email_domain,
            public_host,
        } => {
            let role = match parse_role(role.as_deref().unwrap_or("edit")) {
                Ok(r) => r,
                Err(e) => return (ControlResponse::err(e), false),
            };
            let name = display_name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    std::env::var("USER").unwrap_or_else(|_| "Zed".into())
                });
            match HostSession::start(ShareOpts {
                port: port.unwrap_or(7742),
                role,
                display_name: name,
                require_approval: require_approval.unwrap_or(true),
                repo_remote,
                allowed_email_domain,
                public_host,
            })
            .await
            {
                Ok(host) => {
                    let snap = host.snapshot().await;
                    let mut guard = session.lock().await;
                    guard.shutdown().await;
                    *guard = LiveSession::Sharing(host);
                    (ControlResponse::ok_share(snap), false)
                }
                Err(e) => (ControlResponse::err(e), false),
            }
        }
        ControlRequest::Stop => {
            let mut guard = session.lock().await;
            match std::mem::replace(&mut *guard, LiveSession::Idle) {
                LiveSession::Sharing(host) => {
                    host.stop().await;
                    (ControlResponse::ok_msg("stopped sharing"), false)
                }
                LiveSession::Joined(client) => {
                    client.disconnect().await;
                    (ControlResponse::ok_msg("left session (was not sharing)"), false)
                }
                LiveSession::Idle => (ControlResponse::ok_msg("not sharing"), false),
            }
        }
        ControlRequest::Approve { user_id } => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Sharing(host) => match host.approve(&user_id) {
                    Ok(()) => (ControlResponse::ok_msg(format!("approved {user_id}")), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                _ => (ControlResponse::err("share a session first"), false),
            }
        }
        ControlRequest::Deny { user_id } => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Sharing(host) => match host.deny(&user_id) {
                    Ok(()) => (ControlResponse::ok_msg(format!("denied {user_id}")), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                _ => (ControlResponse::err("share a session first"), false),
            }
        }
        ControlRequest::Publish {
            content,
            event_type,
        } => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Sharing(host) => {
                    match host
                        .publish(&content, event_type.as_deref().unwrap_or("user"))
                        .await
                    {
                        Ok(()) => (ControlResponse::ok_msg("published"), false),
                        Err(e) => (ControlResponse::err(e), false),
                    }
                }
                _ => (ControlResponse::err("share a session first"), false),
            }
        }
        ControlRequest::Leave => {
            let mut guard = session.lock().await;
            match std::mem::replace(&mut *guard, LiveSession::Idle) {
                LiveSession::Joined(client) => {
                    client.disconnect().await;
                    (ControlResponse::ok_msg("left session"), false)
                }
                LiveSession::Sharing(host) => {
                    host.stop().await;
                    (ControlResponse::ok_msg("stopped sharing"), false)
                }
                LiveSession::Idle => (ControlResponse::ok_msg("not connected"), false),
            }
        }
        ControlRequest::Chat { content } => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Joined(client) => match client.send_chat(&content) {
                    Ok(()) => (ControlResponse::ok_msg("chat sent"), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                LiveSession::Sharing(host) => match host.send_chat_named(&content).await {
                    Ok(()) => (ControlResponse::ok_msg("chat sent"), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                LiveSession::Idle => (ControlResponse::err("not connected"), false),
            }
        }
        ControlRequest::Prompt { content } => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Joined(client) => match client.send_prompt(&content) {
                    Ok(()) => (ControlResponse::ok_msg("prompt sent"), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                LiveSession::Sharing(_) => (
                    ControlResponse::err(
                        "you are hosting — joiners send prompts; use publish for host/AI lines",
                    ),
                    false,
                ),
                LiveSession::Idle => (ControlResponse::err("not connected"), false),
            }
        }
        ControlRequest::Status => {
            let guard = session.lock().await;
            match &*guard {
                LiveSession::Joined(client) => {
                    let snap = client.snapshot().await;
                    (ControlResponse::ok_status(snap), false)
                }
                LiveSession::Sharing(host) => {
                    let snap = host.snapshot().await;
                    (ControlResponse::ok_share(snap), false)
                }
                LiveSession::Idle => (
                    ControlResponse::ok_status(chorus_zed_helper::client::SessionSnapshot {
                        status: chorus_zed_helper::client::JoinStatus::Disconnected,
                        host: String::new(),
                        display_name: String::new(),
                        session_id: None,
                        users: vec![],
                        recent_events: vec![],
                        recent_chat: vec![],
                        last_error: None,
                    }),
                    false,
                ),
            }
        }
    }
}
