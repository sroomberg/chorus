# chorus

Collaborative OpenCode session sharing. Pair-program a live AI session from another OpenCode instance in real time.

## What it does

- **Session sharing** — host runs `/chorus-share` and sends a join command to a collaborator
- **Pair programming** — joiners with `edit` (default) can send prompts into the host’s LLM session
- **Live chat** — `/chorus-chat` side channel via temporary TUI toasts (does not pollute session history)
- **Cloud backup** — optional archive of session events to S3/R2

## How it works

Chorus is an [OpenCode](https://github.com/sst/opencode) plugin plus a **Rust WebSocket relay** (`chorus-relay`).

```
Host runs opencode                 → plugin loads
Host runs: /chorus-share           → plugin spawns chorus-relay + issues join token
Joiner runs: /chorus-join          → connects to relay /ws
Joiner prompts                     → relay → host control channel → host session.prompt
```

Both sides need OpenCode + the chorus plugin. The host machine needs the `chorus-relay` binary on `PATH` or built in-repo (`target/release/chorus-relay`). Override with `CHORUS_RELAY_BIN`.

## Installation

Until packages are published to npm, install from this repo:

```sh
# Build the Rust relay
cargo build -p chorus-relay --release

# Link the plugin into your OpenCode project
mkdir -p .opencode/plugin
bun add --cwd .opencode/plugin /path/to/chorus/packages/plugin
```

Then add to OpenCode config:

```json
{
  "plugin": ["@chorus/plugin"]
}
```

## Packages / crates

| Path | Description |
|---|---|
| `packages/plugin` | OpenCode plugin — tools, hooks, spawns/manages relay |
| `packages/shared` | Shared TypeScript types (joiner + host-control protocols) |
| `crates/chorus-relay` | Rust WebSocket relay (`/ws` joiners, `/host` control plane) |

## Development

```sh
bun install
bun run build          # release relay + TS packages
bun run test           # relay tests + TS/Bun tests
bun run typecheck
cargo test -p chorus-relay
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CHORUS_PORT` | `7742` | Relay listen port |
| `CHORUS_RELAY_BIN` | auto-detect | Path to `chorus-relay` binary |
| `CHORUS_HOST_TOKEN` | random | Host control secret (set by plugin when spawning) |
| `CHORUS_AWS_BUCKET` | — | S3/R2 bucket for session backup |
| `CHORUS_AWS_REGION` | `us-east-1` | AWS region |
| `CHORUS_AWS_ENDPOINT` | — | Custom endpoint (for R2/MinIO) |

Remote tunneling (`bore` / `cloudflared`) is not implemented yet — share a LAN IP + port for now.

## Roadmap & decisions

- [docs/STATUS.md](docs/STATUS.md) — what’s done and what still needs to happen
- [docs/DECISIONS.md](docs/DECISIONS.md) — OpenCode plugin vs from-scratch, languages, license
- [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) — third-party license audit for commercial use

## License

MIT
