use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use clap::{Parser, Subcommand};
use chorus_zed_helper::client::JoinClient;
use chorus_zed_helper::control::{
    pid_path, runtime_dir, socket_path, ControlRequest, ControlResponse,
};
use chorus_zed_helper::mcp::{self, format_status};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

#[derive(Parser, Debug)]
#[command(
    name = "chorus-zed-helper",
    about = "Chorus join client for Zed (CLI + MCP). Joiner-only — does not host/share."
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
    /// Disconnect from the current session
    Leave,
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
            // MCP uses blocking stdin reads; keep a multi-thread runtime handle.
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
        Commands::Status => {
            match request(ControlRequest::Status).await {
                Ok(resp) => {
                    print_response(&resp);
                    if !resp.ok {
                        std::process::exit(1);
                    }
                }
                Err(_) => {
                    println!("status: disconnected\n(daemon not running)");
                }
            }
        }
        Commands::Shutdown => {
            match request(ControlRequest::Shutdown).await {
                Ok(resp) => print_response(&resp),
                Err(_) => println!("daemon not running"),
            }
        }
    }
    Ok(())
}

fn print_response(resp: &ControlResponse) {
    if let Some(snap) = &resp.snapshot {
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
    let session: Mutex<Option<JoinClient>> = Mutex::new(None);

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
    session: &Mutex<Option<JoinClient>>,
    req: ControlRequest,
) -> (ControlResponse, bool) {
    match req {
        ControlRequest::Ping => (ControlResponse::ok_msg("pong"), false),
        ControlRequest::Shutdown => {
            let mut guard = session.lock().await;
            if let Some(client) = guard.take() {
                client.disconnect().await;
            }
            (ControlResponse::ok_msg("shutting down"), true)
        }
        ControlRequest::Join {
            host,
            token,
            display_name,
            repo_remote,
            email,
        } => {
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
                    if let Some(old) = guard.take() {
                        old.disconnect().await;
                    }
                    *guard = Some(client);
                    (ControlResponse::ok_status(snap), false)
                }
                Err(e) => (ControlResponse::err(e), false),
            }
        }
        ControlRequest::Leave => {
            let mut guard = session.lock().await;
            if let Some(client) = guard.take() {
                client.disconnect().await;
                (ControlResponse::ok_msg("left session"), false)
            } else {
                (ControlResponse::ok_msg("not connected"), false)
            }
        }
        ControlRequest::Chat { content } => {
            let guard = session.lock().await;
            match guard.as_ref() {
                Some(client) => match client.send_chat(&content) {
                    Ok(()) => (ControlResponse::ok_msg("chat sent"), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                None => (ControlResponse::err("not connected"), false),
            }
        }
        ControlRequest::Prompt { content } => {
            let guard = session.lock().await;
            match guard.as_ref() {
                Some(client) => match client.send_prompt(&content) {
                    Ok(()) => (ControlResponse::ok_msg("prompt sent"), false),
                    Err(e) => (ControlResponse::err(e), false),
                },
                None => (ControlResponse::err("not connected"), false),
            }
        }
        ControlRequest::Status => {
            let guard = session.lock().await;
            match guard.as_ref() {
                Some(client) => {
                    let snap = client.snapshot().await;
                    (ControlResponse::ok_status(snap), false)
                }
                None => (
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
