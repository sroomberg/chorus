# Chorus Zed extension (v1 — join + share)

Join or **host** a Chorus collaborative session from [Zed](https://zed.dev) via a **native helper** + **MCP context server**.

Zed extensions run as `wasm32-wasip2` and cannot hold long-lived WebSocket UIs themselves. This package is the thin WASM adapter; `crates/chorus-zed-helper` speaks the Chorus `/ws` (join) and `/host` (share) protocols.

## What works (v1)

| Capability | How |
|---|---|
| Host / share | MCP `chorus_share` or CLI `chorus-zed-helper share` |
| Approve / deny joiners | `chorus_approve` / `chorus_deny` |
| Stop sharing | `chorus_stop` / `stop` |
| Publish host/AI lines | `chorus_publish` / `publish` |
| Join a host’s relay | MCP tool `chorus_join` or CLI `chorus-zed-helper join` |
| Leave | `chorus_leave` / `leave` |
| Side-channel chat | `chorus_chat` / `chat` |
| Forward prompts (`collab.input`) | `chorus_prompt` / `prompt` (needs `edit` role; joiner only) |
| Status / recent events | `chorus_status` / `status` |

## What does **not** work (honest limits)

- **OpenCode LLM loop** — Zed/VS Code share does not inject into OpenCode. Joiner prompts show up in `chorus_status` (and you can `chorus_publish` host/AI lines). Pair with the OpenCode plugin if you want the model to run those prompts automatically.
- **OpenCode transcript mirroring** — session events are visible via `chorus_status` / helper state, not injected into a local agent transcript.
- **Extension slash commands** — Zed removed extension slash commands; use MCP tools (or the CLI).

## Access control

Aligned with the OpenCode plugin / `chorus-relay` session gates:

- **Required display name** (`display_name` / `--name`)
- **Host approval** — `chorus_share` defaults to `require_approval=true`; joiners stay `pending` until `chorus_approve`
- **Optional repo gate** — pass `repo_remote` / `--repo-remote` (defaults to `git remote get-url origin`)
- **Optional email domain** — `allowed_email_domain`

## Architecture

```
Zed Agent Panel
    └─ MCP (stdio) ──► chorus-zed-helper mcp
                            ├─ share: in-process chorus-relay + /host
                            └─ join:  WebSocket ──► chorus-relay /ws
```

CLI subcommands talk to a short-lived background daemon over a Unix socket so `share` / `join` / `chat` / `status` share one connection. MCP holds its own in-process session (Agent Panel).

## Install the native helper

From the monorepo root:

```sh
cargo install --path crates/chorus-zed-helper --force
```

Verify:

```sh
chorus-zed-helper --help
```

If a previous daemon is running, `chorus-zed-helper shutdown` first so it picks up the new binary.

## Install Dev Extension in Zed

1. Install `chorus-zed-helper` on `PATH` (above).
2. Install the `wasm32-wasip2` target if needed: `rustup target add wasm32-wasip2`.
3. In Zed: command palette → **zed: extensions**.
4. Click **Install Dev Extension**.
5. Select this directory: `packages/zed` (the folder that contains `extension.toml`).
6. Enable the **Chorus** context server in Agent / MCP settings if it is not auto-enabled.
7. Confirm tools `chorus_share`, `chorus_join`, `chorus_approve`, `chorus_status`, … appear.

If the context server fails to start, register a manual context server in `settings.json`:

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

## CLI usage

```sh
# Host from this machine
chorus-zed-helper share --name Steven
chorus-zed-helper status          # includes join command + pending users
chorus-zed-helper approve <userId>
chorus-zed-helper publish "looking at the failing test"
chorus-zed-helper stop

# Join someone else's share
chorus-zed-helper join --host 192.168.1.10:7742 --token <join-token> --name Alex
chorus-zed-helper prompt "fix the flaky auth test"
chorus-zed-helper leave
```

`share` defaults to host approval. Pass `--auto-admit` to skip it.

## Develop / test

```sh
# Helper unit + integration tests (in-process chorus-relay)
cargo test -p chorus-zed-helper

# Extension WASM (optional local check; Zed also builds on Install Dev Extension)
cd packages/zed
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2
```

Protocol fixtures live in `/protocol`; Rust types are shared via `chorus-relay::protocol`.
