use clap::Parser;
use chorus_relay::server::{serve, RelayConfig};
use rand::RngCore;

#[derive(Parser, Debug)]
#[command(name = "chorus-relay", about = "Chorus collaborative session relay")]
struct Args {
    /// Port for joiner WebSocket (`/ws`) and host control (`/host`)
    #[arg(long, env = "CHORUS_PORT", default_value_t = 7742)]
    port: u16,

    /// Bind address (default 0.0.0.0 for LAN access)
    #[arg(long, env = "CHORUS_BIND", default_value = "0.0.0.0")]
    bind: String,

    /// Shared secret for the host control channel. Generated if omitted.
    #[arg(long, env = "CHORUS_HOST_TOKEN")]
    host_token: Option<String>,

    /// CIDR or IP allowlist (repeat or comma-separated). Empty = no IP allow restriction.
    #[arg(long = "allow-cidr", env = "CHORUS_ALLOWED_CIDRS", value_delimiter = ',')]
    allowed_cidrs: Vec<String>,

    /// CIDR or IP denylist (repeat or comma-separated). Deny wins over allow.
    #[arg(long = "deny-cidr", env = "CHORUS_DENIED_CIDRS", value_delimiter = ',')]
    denied_cidrs: Vec<String>,

    /// Peer source-port allowlist (repeat or comma-separated). Empty = any source port.
    /// Useful for single-machine e2e where all peers are 127.0.0.1.
    #[arg(long = "allow-port", env = "CHORUS_ALLOWED_PORTS", value_delimiter = ',')]
    allowed_ports: Vec<u16>,

    /// Allow binding to 0.0.0.0 / :: (open all interfaces). Disable for enterprise.
    #[arg(long, env = "CHORUS_ALLOW_OPEN_BIND", default_value_t = true, action = clap::ArgAction::Set)]
    allow_open_bind: bool,

    /// When an allowlist is set, still admit loopback IPs (host plugin on same machine).
    /// Source-port allowlists still apply to loopback peers.
    #[arg(long, env = "CHORUS_ALLOW_LOOPBACK", default_value_t = true, action = clap::ArgAction::Set)]
    allow_loopback: bool,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let host_token = args.host_token.unwrap_or_else(|| random_hex(32));

    // Print so the spawning plugin can scrape it if it didn't supply one.
    eprintln!("CHORUS_HOST_TOKEN={host_token}");
    eprintln!("CHORUS_RELAY_READY port={}", args.port);

    serve(RelayConfig {
        port: args.port,
        host_token,
        bind: args.bind,
        allowed_cidrs: args.allowed_cidrs,
        denied_cidrs: args.denied_cidrs,
        allowed_ports: args.allowed_ports,
        allow_open_bind: args.allow_open_bind,
        allow_loopback: args.allow_loopback,
    })
    .await
}
