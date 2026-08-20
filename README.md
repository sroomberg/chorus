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

## Layout

One monorepo, two ecosystems, one wire contract:

| Path | Artifact | Description |
|---|---|---|
| `packages/plugin` | npm `@chorus/plugin` | OpenCode plugin — tools, hooks, spawns/manages relay |
| `packages/shared` | npm `@chorus/shared` | TypeScript types + codecs for joiner and host-control protocols |
| `crates/chorus-relay` | `chorus-relay` binary | Rust WebSocket relay (`/ws` joiners, `/host` control plane) |
| `protocol/` | fixtures (not published) | Canonical JSON examples both TS and Rust must deserialize |

Root `package.json` scripts are the only task entry (`build`, `test`, `typecheck`). Bun workspaces own `packages/*`; Cargo owns `crates/*`.

## Development

```sh
bun install
bun run build          # release relay + TS packages
bun run test           # relay tests + TS/Bun tests (includes protocol fixtures)
bun run typecheck
cargo test -p chorus-relay
```

### Multi-agent local testing

Run several isolated OpenCode servers on one machine (each with Chorus loaded) and drive share/join over the HTTP API:

```sh
# Requires `opencode` on PATH (https://opencode.ai/docs)
bun run multi-agent -- setup --agents 3
bun run multi-agent -- up --agents 3
bun run multi-agent -- smoke          # health + chorus tools registered
bun run multi-agent -- pair           # /chorus-share then /chorus-join
bun run multi-agent -- down

# Protocol-only stress (no OpenCode): N concurrent JoinClients
bun run test:relay-stress
```

See `bun run multi-agent -- help` for ports/env (`OPENCODE_BASE_PORT`, `CHORUS_BASE_PORT`, `OPENCODE_BIN`).

### Docker agents + host relay

Run `chorus-relay` on your machine and OpenCode agents in containers (different published ports). Containers reach the relay via `host.docker.internal`.

```sh
bun run build                         # release relay + plugin dist (needed for image)
bun run docker-agents -- up --agents 2
bun run docker-agents -- smoke
bun run docker-agents -- pair         # /chorus-share then /chorus-join across containers
bun run docker-agents -- down
```

`up` starts the host relay on `0.0.0.0:7742`, builds `chorus-opencode-agent:local`, and publishes agents on `4100+`. Override with `CHORUS_PORT`, `OPENCODE_BASE_PORT`, `CHORUS_HOST_TOKEN`, `OPENCODE_VERSION`.

For live mirrored context on joiners, open the **web UI** (not only `opencode attach`):

- Host: http://127.0.0.1:4100  
- Joiner: http://127.0.0.1:4101  

`opencode attach` works for driving the session, but OpenCode’s attach TUI often does not live-render plugin-injected transcript lines.

## Configuration

Chorus reads a layered **config file** plus environment variables.

### Config file (`chorus.json`)

Search order (later layers override earlier keys):

1. Built-in defaults
2. System / org: `/etc/chorus/config.json` (or `CHORUS_SYSTEM_CONFIG`)
3. User: `~/.config/chorus/config.json`
4. Project: `./chorus.json` or `./.chorus/config.json`
5. Explicit file: `CHORUS_CONFIG=/path/to/config.json`
6. Environment variables (ops overrides for port, public host, backup)

Copy [chorus.example.json](./chorus.example.json) to get started. Example enterprise lock:

```json
{
  "org": { "name": "Acme Engineering" },
  "security": {
    "requireApproval": true,
    "allowSkipApproval": false,
    "requireRepoMatch": true,
    "requireEmailDomainMatch": true,
    "allowedEmailDomain": "acme.com",
    "additionalRepoRemotePrefixes": ["git://"],
    "repoRemoteRewrites": [{ "from": "github.acme.com", "to": "github.com" }],
    "defaultRole": "edit",
    "tokenTtlMs": 86400000
  }
}
```

These knobs are pairing controls, not a complete enterprise ACL: email and git remote are **self-asserted** on join, and later config layers (user/project) can still override `/etc/chorus/config.json`. See [docs/ENTERPRISE.md](docs/ENTERPRISE.md) for the gaps a security review will hit.

| Field | Default | Description |
|---|---|---|
| `security.requireApproval` | `false` | Joiners pending until host approve/deny |
| `security.allowSkipApproval` | `true` | If `false`, tool args cannot turn approval off |
| `security.requireRepoMatch` | `false` | If `true`, share fails without a git `origin` |
| `security.requireEmailDomainMatch` | `false` | If `true`, share fails unless `allowedEmailDomain` is set; joiners must use that domain |
| `security.allowedEmailDomain` | — | Company email domain (e.g. `acme.com`) enforced on join |
| `security.additionalRepoRemotePrefixes` | `[]` | Extra git URL prefixes to strip when matching remotes (e.g. `git://`) |
| `security.repoRemoteRewrites` | `[]` | Host substitutions after normalize (e.g. `{ "from": "github.acme.com", "to": "github.com" }`) |
| `security.defaultRole` | `edit` | Role when `/chorus-share` omits role |
| `security.tokenTtlMs` | — | Optional join-token TTL |
| `relay.port` / `relay.publicHost` | — | Relay listen / advertised join host |
| `backup.bucket` / `region` / `endpoint` | — | Optional S3/R2 backup |
| `org.name` / `org.policyNote` | — | Shown in share + status |

`/chorus-status` prints the effective config and which files contributed.

### Environment variables

| Env var | Default | Description |
|---|---|---|
| `CHORUS_CONFIG` | — | Absolute path to a config JSON file (highest file layer) |
| `CHORUS_SYSTEM_CONFIG` | `/etc/chorus/config.json` | Org-wide config path |
| `CHORUS_USER_CONFIG` | `~/.config/chorus/config.json` | Per-user config path override |
| `CHORUS_PORT` | `7742` | Relay listen port (overrides file) |
| `CHORUS_RELAY_BIN` | auto-detect | Path to `chorus-relay` binary |
| `CHORUS_HOST_TOKEN` | random | Host control secret (set by plugin when spawning) |
| `CHORUS_RELAY_HOST` | `127.0.0.1` | Relay host to attach to (e.g. `host.docker.internal:7742`) |
| `CHORUS_PUBLIC_HOST` | local IP:port | Host:port advertised in `/chorus-share` join URLs |
| `CHORUS_EXTERNAL_RELAY` | — | `1` to attach to an existing relay (no spawn/kill) |
| `CHORUS_AWS_BUCKET` | — | S3/R2 bucket for session backup |
| `CHORUS_AWS_REGION` | `us-east-1` | AWS region |
| `CHORUS_AWS_ENDPOINT` | — | Custom endpoint (for R2/MinIO) |

### Session access control

| Control | Behavior |
|---|---|
| Join token | Still required; issued by `/chorus-share` with a role |
| Display name | **Required** on `/chorus-join` — empty names are rejected |
| Host approval | Config `security.requireApproval` (default off); when on, joiners appear in a live numbered queue — `/chorus-approve 1` (full userId still works) |
| Git repo gate | If the host share directory has `origin` (or `requireRepoMatch`), joiners must present the same remote. Extra prefixes/rewrites come from `additionalRepoRemotePrefixes` / `repoRemoteRewrites`. |
| Company email gate | If `allowedEmailDomain` is set (or `requireEmailDomainMatch`), joiners must auth with an email at that domain |
| Kick | `/chorus-kick <userId>` disconnects an active joiner |

Remote tunneling (`bore` / `cloudflared`) is not implemented yet — share a LAN IP + port for now.

## Roadmap & decisions

- [docs/STATUS.md](docs/STATUS.md) — what’s done and what still needs to happen
- [docs/DECISIONS.md](docs/DECISIONS.md) — OpenCode plugin vs from-scratch, languages, license
- [docs/ENTERPRISE.md](docs/ENTERPRISE.md) — security gaps for enterprise use (claims vs proofs, policy floor, SSO, audit)
- [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) — third-party license audit for commercial use

## License

MIT
