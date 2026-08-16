# Chorus Zed extension (v1 — joiner)

Join an existing Chorus collaborative session from [Zed](https://zed.dev) via a **native helper** + **MCP context server**.

Zed extensions run as `wasm32-wasip2` and cannot hold long-lived WebSocket UIs themselves. This package is the thin WASM adapter; `crates/chorus-zed-helper` speaks the Chorus `/ws` protocol.

## What works (v1)

| Capability | How |
|---|---|
| Join a host’s relay | MCP tool `chorus_join` or CLI `chorus-zed-helper join` |
| Leave | `chorus_leave` / `leave` |
| Side-channel chat | `chorus_chat` / `chat` |
| Forward prompts (`collab.input`) | `chorus_prompt` / `prompt` (needs `edit` role) |
| Status / recent events | `chorus_status` / `status` |

## What does **not** work (honest limits)

- **Host share / stop** — Zed cannot inject into an OpenCode agent session. Hosting still requires the OpenCode plugin (`/chorus-share`).
- **OpenCode transcript mirroring** — session events are visible via `chorus_status` / helper state, not injected into a local agent transcript.
- **Extension slash commands** — Zed removed extension slash commands; use MCP tools (or the CLI). Tool names mirror OpenCode’s `/chorus-join`, `/chorus-leave`, `/chorus-chat`, `/chorus-status`.

## Access control

Aligned with the OpenCode plugin / `chorus-relay` session gates:

- **Required display name** (`display_name` / `--name`)
- **Host approval** — join may return `pending` until the host runs `chorus-approve`
- **Optional repo gate** — pass `repo_remote` / `--repo-remote` when the host bound `session.policy.repoRemote`

## Architecture

```
Zed Agent Panel
    └─ MCP (stdio) ──► chorus-zed-helper mcp
                            └─ WebSocket ──► chorus-relay /ws
                                                 └─ host OpenCode plugin
```

CLI subcommands talk to a short-lived background daemon over a Unix socket so `join` / `chat` / `status` share one connection.

## Install the native helper

From the monorepo root:

```sh
cargo build -p chorus-zed-helper --release
# put it on PATH, e.g.:
cp target/release/chorus-zed-helper ~/.local/bin/
```

Or:

```sh
cargo install --path crates/chorus-zed-helper
```

Verify:

```sh
chorus-zed-helper --help
```

## Install Dev Extension in Zed

1. Build/install `chorus-zed-helper` on `PATH` (above).
2. Install the `wasm32-wasip2` target if needed: `rustup target add wasm32-wasip2`.
3. In Zed: command palette → **zed: extensions**.
4. Click **Install Dev Extension**.
5. Select this directory: `packages/zed` (the folder that contains `extension.toml`).
6. Enable the **Chorus** context server in Agent / MCP settings if it is not auto-enabled.
7. Confirm tools `chorus_join`, `chorus_leave`, `chorus_chat`, `chorus_prompt`, `chorus_status` appear.

If the context server fails to start, Zed cannot find `chorus-zed-helper`. Fix `PATH`, or register a manual context server in `settings.json`:

```json
{
  "context_servers": {
    "chorus": {
      "command": "/absolute/path/to/chorus-zed-helper",
      "args": ["mcp"]
    }
  }
}
```

## CLI usage (without Zed)

```sh
# Host must already be sharing via OpenCode /chorus-share
chorus-zed-helper join --host 192.168.1.10:7742 --token <join-token> --name Alex
chorus-zed-helper status
chorus-zed-helper chat "hey — looking at the failing test"
chorus-zed-helper prompt "fix the flaky auth test"
chorus-zed-helper leave
```

## Develop / test

```sh
# Helper unit + integration tests (spins up chorus-relay)
cargo test -p chorus-zed-helper

# Extension WASM (optional local check; Zed also builds on Install Dev Extension)
cd packages/zed
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2
```

Protocol fixtures live in `/protocol`; Rust types are shared via `chorus-relay::protocol`.
