# Changelog

## Unreleased

### Network access restrictions

- **CIDR / IP allowlist** on `chorus-relay` (`--allow-cidr` / `relay.allowedCidrs` / `CHORUS_ALLOWED_CIDRS`) — peers outside the list get HTTP 403 before auth
- **Bind policy** — `relay.bind` / `CHORUS_BIND`; `relay.allowOpenBind: false` refuses `0.0.0.0` / `::`
- Loopback remains admitted by default when an allowlist is set (`allowLoopback`) so the host plugin can reach `/host`
- Docs: [docs/NETWORK.md](docs/NETWORK.md) (VPN, Tailscale, AWS VPC, Azure VNet, GCP VPC)

## v1.0.0 — 2026-08-20

First stable release of Chorus: **OpenCode↔OpenCode pair programming on one live AI session**. The host shares a session; collaborators join over a LAN WebSocket relay and send prompts into the same LLM turn. Side-channel chat stays in toasts; the shared transcript is mirrored into each joiner’s OpenCode session.

GitHub tag `v1.0.0` is the source of truth for this release. `@chorus/plugin` is still install-from-git (packages are private; npm publish is not in this release).

### Install

Both sides need [OpenCode](https://opencode.ai) and this plugin. The **host** also needs the `chorus-relay` binary.

```sh
git clone https://github.com/sroomberg/chorus.git
cd chorus
cargo build -p chorus-relay --release

mkdir -p .opencode/plugin
bun add --cwd .opencode/plugin /path/to/chorus/packages/plugin
```

OpenCode config:

```json
{
  "plugin": ["@chorus/plugin"]
}
```

Put `target/release/chorus-relay` on `PATH`, or set `CHORUS_RELAY_BIN`. Default relay port is `7742` (`CHORUS_PORT`). Remote tunneling (`bore` / `cloudflared`) is not in this release — share a LAN IP + port.

### Use

1. Host: `/chorus-share` (optional role `edit` | `view` | `admin`; optional `requireApproval=true`)
2. Send the printed `/chorus-join` command to the collaborator. Fill in `name="YOUR_NAME"` (required). Include `email="you@company.com"` when the host enforces a company domain.
3. Joiner: run that `/chorus-join`. If approval is on, the host sees a live numbered queue — `/chorus-approve 1` / `/chorus-deny 1` (or omit the id when only one joiner is waiting; full userId still works).
4. Joiner prompts go to the **host** session (local joiner LLM is aborted). Everyone should see `[Host]:` / `[name]:` / `[AI]:` in the transcript.
5. `/chorus-chat` is a toast-only side channel. `/chorus-status` shows connected users, the pending queue, and effective config. `/chorus-leave` / `/chorus-stop` end join / sharing. `/chorus-kick <userId>` disconnects a joiner.

Prefer the **OpenCode web UI** for live mirrored lines. `opencode attach` often does not live-render plugin-injected transcript.

### Highlights since v0.1.6

- **Rust relay** — in-process Bun WebSocket server replaced by `crates/chorus-relay`. Plugin spawns/manages it (`CHORUS_RELAY_BIN` override). Host control plane on `/host` (token issue, session events, chat, `collab.input`); joiner protocol on `/ws` is unchanged.
- **Shared transcript** — collaborator prompts fan out to every joiner; joiners inject `[Host]:` / `[AI]:` (including history replay on join). Toast-only viewing is no longer the primary UX.
- **Loop guard** — an agent cannot share and join at once; hosts never mirror; echoed `[AI]:` / `[Host]:` collab lines are dropped.
- **Layered config** — `chorus.json` / `.chorus/config.json` / `~/.config/chorus/config.json` / `/etc/chorus/config.json` (plus `CHORUS_CONFIG`). Later layers win. `/chorus-status` prints effective config and which files contributed. Copy `chorus.example.json`.
- **Session access control**
  - Join token still required; role baked in at `/chorus-share`
  - Display name required (empty / whitespace rejected)
  - Optional host approval (`security.requireApproval`, default off) with a live numbered pending queue (`/chorus-approve 1` / `/chorus-deny 1`)
  - Git origin binding: if the host share directory has `origin` (or `requireRepoMatch`), joiners must present the same remote (claim check, not GitHub/GitLab ACL). Extra prefixes/rewrites: `additionalRepoRemotePrefixes` / `repoRemoteRewrites`
  - Optional company email gate (`allowedEmailDomain` / `requireEmailDomainMatch`)
  - `/chorus-kick` for active joiners
  - Enterprise locks: `allowSkipApproval=false` prevents turning approval off from tool args
- **Share command** — printed join line includes `name="YOUR_NAME"` and optional `[email="<work-email>"]`
- **Enterprise docs** — `docs/ENTERPRISE.md` covers security gaps (claims vs proofs, org policy floor, SSO, TLS/token hygiene, audit)

### Breaking changes

- Hosts must run `chorus-relay`; the embedded Bun relay is gone.
- `/chorus-join` requires a real display name (`YOUR_NAME` placeholder is not accepted).
- Joiners now receive transcript lines in session history, not only toasts.

### Config & env (short)

| Control | Default | Notes |
|---|---|---|
| `security.requireApproval` | `false` | Pending numbered queue until `/chorus-approve` |
| `security.allowSkipApproval` | `true` | If `false`, share cannot disable approval |
| `security.requireRepoMatch` | `false` | Share fails without git `origin` when true |
| `security.allowedEmailDomain` | — | Joiners must use that email domain |
| `relay.port` / `CHORUS_PORT` | `7742` | Listen port |
| `CHORUS_PUBLIC_HOST` | local IP:port | Host:port in join URLs |
| `CHORUS_AWS_BUCKET` | — | Optional S3/R2 session backup |

Full tables: [README](https://github.com/sroomberg/chorus/blob/main/README.md). Status and backlog: [docs/STATUS.md](https://github.com/sroomberg/chorus/blob/main/docs/STATUS.md). Enterprise gaps: [docs/ENTERPRISE.md](https://github.com/sroomberg/chorus/blob/main/docs/ENTERPRISE.md).

## v0.1.6 — 2026-05-27

- Fix: `chorus-share` output now shows a ready-to-run `/chorus-join` command instead of raw token + host fields

## v0.1.3 — 2026-05-27

- Feature: `chorus-chat` tool — send chat messages visible to all participants as temporary TUI toasts
- Feature: host and joiner both see prompts and AI responses labeled by sender via TUI toasts — `[Host]:`, `[JoinerName]:`, `[AI]:`
- Feature: "user typing…" bubble — 2-second toast shown when a collaborator is about to send a chat message
- Feature: AI responses forwarded to joiners via `experimental.text.complete` hook; shown as truncated preview toasts
- Fix: notifications are temporary toasts (not injected into session history) so they don't clutter the conversation

## v0.1.1 — 2026-05-27

- Fix: plugin failed to load — OpenCode calls every module export as a factory function, so named class re-exports (`AccessManager`, `RelayServer`, etc.) caused a "class constructor called without new" crash on startup
- Fix: chorus tools were not registered — the plugin was using the wrong API (`"tool.register"` hook with JSON Schema args); rewritten to use `hooks.tool` with Zod schemas per the real `@opencode-ai/plugin` v1.15.11 spec
- Fix: joining user appeared twice in the connected user list — relay sent `user.list` (already containing the joiner) then broadcast `user.joined` to all clients including the joiner

## v0.1.0 — 2026-05-27

Initial release.

- OpenCode plugin that lets multiple developers share and collaborate on a live session
- `chorus-share`: start sharing a session and issue a join token; supports `edit` (default), `view`, and `admin` roles
- `chorus-join`: join another user's shared session; forwarded messages appear in the host's OpenCode session
- `chorus-leave`: disconnect from a joined session
- `chorus-status`: show current sharing/join state and connected user list
- `chorus-stop`: stop the relay and end sharing
- Embedded Bun WebSocket relay server (default port 7742, overridable via `CHORUS_PORT`)
- Token-based access control with per-token roles baked in at issuance time
- Optional S3/R2 cloud backup of session events (configure via `CHORUS_AWS_BUCKET`, `CHORUS_AWS_REGION`, `CHORUS_AWS_ENDPOINT`)
- Slash commands (`/chorus-share`, `/chorus-join`, etc.) auto-installed to `~/.config/opencode/commands/` on first load
