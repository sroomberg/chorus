use zed_extension_api::{self as zed, Command, ContextServerId, Project, Result};

struct ChorusExtension;

impl zed::Extension for ChorusExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Command> {
        // The WebSocket join client lives in the native `chorus-zed-helper` binary.
        // Install it on PATH (`cargo install --path crates/chorus-zed-helper` from the repo,
        // or `cargo build -p chorus-zed-helper --release` and copy `target/release/chorus-zed-helper`).
        // Override the binary path via Zed settings `context_servers.chorus` env if needed.
        Ok(Command {
            command: "chorus-zed-helper".into(),
            args: vec!["mcp".into()],
            env: vec![],
        })
    }
}

zed::register_extension!(ChorusExtension);
