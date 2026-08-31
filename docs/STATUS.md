# Chorus status — what still needs to happen

Snapshot as of 2026-08-31 (`v2.1.0` — VS Code adapter + `@chorus/client`). Tests/typecheck/build are green.

## Current state

Chorus is a **relay-first** LAN collaboration stack with two adapters on one wire protocol:

- **OpenCode** (terminal): `/chorus-share` → spawns Rust `chorus-relay` + issues token via `/host`; `/chorus-join` → `/ws`; full LLM loop + transcript mirror
- **VS Code** (`packages/vscode`): same `JoinClient` + `RelayServer` via `@chorus/client`; can host relay for terminal joiners or join a terminal host
- Side channel: `/chorus-chat` + typing toasts (OpenCode); VS Code panel chat
- Optional S3/R2 backup of user events
- **v2.0.0 network lockdown**: CIDR allow/deny, bind policy, source-port allowlist ([docs/NETWORK.md](./NETWORK.md))

The browser companion (`packages/web`) was intentionally removed. Joiners mirror the host transcript into their OpenCode session (`[Host]:` / `[AI]:` lines via `noReply` inject); side-channel chat/typing remain toasts.
The in-process Bun relay has been replaced by `crates/chorus-relay`.

**Editor adapters:** VS Code shipped in-repo (`packages/vscode`); Zed adapter deferred to a separate branch/PR.

Differentiation vs nearby OpenCode plugins (`opencode-live`, `opencode-sessions`, `opencode-ensemble`, `opencode-relay`): those target **multi-agent / same-DB sync**. Chorus targets **multi-human** pair programming on one live AI session.

## Priority backlog

### P0 — ship honesty & installability

1. Align docs with OpenCode-only product (README drift fixed in this commit).
2. Publish/install path: packages are `"private": true` with no npm publish workflow; documented `bun add @chorus/plugin` does not work for outsiders. Choose git/`file:` install or publish to npm.
3. Add `commands/chorus-chat.md` (tool exists; slash command missing).
4. Fix share slash-command text (still says “print token + host”; tool now emits a ready `/chorus-join` command).

### P0 — collaboration correctness

5. **Joiner dual-session**: joiner prompts are forwarded to the host and the local joiner LLM turn is aborted; mirrored `[AI]:` from the host is the shared reply. Residual risk if `session.abort` races.
6. **True session viewing**: host + all joiners receive the same event stream; joiners inject into their OpenCode transcript. **Live UI:** OpenCode web UI on the agent port updates; `opencode attach` TUI often does not (upstream). Toasts + TUI session nudge are best-effort for attach. Guard: same agent cannot share and join (that mirrored AI replies back into the host and looped).
7. **Host moderation tools**: `chorus-approve` / `chorus-deny` / `chorus-kick` now cover pending admission and kick. Promote/demote still need host-side tools wired to `/host`.

### P1 — remote use & security

Enterprise gap analysis (what would actually pass a security review vs what ships today): [docs/ENTERPRISE.md](./ENTERPRISE.md).

8. Implement `tunnel/` (`bore` / `cloudflared`) or explicitly market LAN-only.
9. Default token TTL; revoke tokens on `chorus-stop`.
10. TLS / auth hardening for off-LAN; protocol decode is bare `JSON.parse`.
11. Stronger repo ACL (GitHub/GitLab API or signed capability) — current gate is same-remote claim only.
12. Host moderation UI polish: live pending join queue with short ids is in `chorus-approve` / `chorus-deny` / `chorus-status`. Bulk approve still open.
13. **Org policy floor** — system config must not be weakenable by user/project `chorus.json` (`allowSkipApproval`, domain, default role, TTL).
14. **Safer default role** (`view`) and joiner tool allowlist — `edit` inherits the host agent’s files/shell/MCP.
15. **Audit log** (share/join/approve/kick/collab.input) exportable to SIEM.
16. **SSO/OIDC** — replace self-asserted `email` on the auth frame.
17. **Backup data handling** — KMS, retention, no-backup org lock, redact secrets/tokens.

### Security shipped (this pass)

- Host approval gate (`requireApproval`, default off for `/chorus-share`; `chorus-approve` / `chorus-deny`)
- Required display name on join (no anonymous / empty names)
- Git origin binding when the host share directory has a remote (joiner must present matching remote)
- `chorus-kick` for active joiners
- Layered `chorus.json` config (org/user/project) for security + relay + backup defaults, with enterprise locks (user/project can still override system; email/repo remain claims — [docs/ENTERPRISE.md](./ENTERPRISE.md))
- **Network allowlist** — `relay.allowedCidrs`, `relay.bind`, `relay.allowOpenBind` / `allowLoopback` (VPN/VPC patterns in [docs/NETWORK.md](./NETWORK.md))

### P1 — reliability

18. Serialize collab input injection (current “queue” can race).
19. JoinClient reconnect + connect timeout.
20. Replay chat history on join (events only today).
21. Refresh installed slash commands on plugin upgrade (today: skip if dest exists).

### P2 — backup & polish

22. Backup AI + chat events; expose restore/list; set `endedAt` on stop.
23. Drop unused `@aws-sdk/lib-storage` or use it.
24. Broader tests: roles/view-forbid, kick/close, chat/typing, plugin entry, tunnel.
25. Native slash-command registration when [opencode#5305](https://github.com/sst/opencode/issues/5305) lands.

### Adapter e2e shipped

- `bun run test:vscode-e2e` — VS Code path: email gate, pending approve, `collab.input`
- `bun run test:vscode-relay-e2e` — three-env gate (host vscode / joiner vscode / disallowed joiner) + VS Code ↔ terminal cross-adapter
- `bun run test:adapters-e2e` — both of the above
- `bun run test:security-e2e` — OpenCode host + protocol joiner (approval flow)
- `bun run test:network-e2e` — CIDR / source-port allowlist on `chorus-relay`

## Local multi-agent harness

`scripts/multi-agent.ts` (via `bun run multi-agent`) can spawn N isolated `opencode serve` instances with the Chorus plugin, then automate `/chorus-share` + `/chorus-join` through OpenCode’s `/session/:id/command` API. Also includes `relay-stress` for concurrent protocol joiners without OpenCode.

## Adapter surface (monorepo)

- **OpenCode** (`packages/plugin`) — primary host; full LLM loop + transcript mirror. Re-exports `@chorus/client` for relay/join.
- **VS Code** (`packages/vscode`) — share/join via `@chorus/client`; sidebar transcript; session access control (approval, email gate, repo gate). Can host relay for terminal joiners or join a terminal host. Does **not** drive OpenCode’s model when sharing — publish host lines manually or pair with OpenCode.
- **Shared client** (`packages/client`) — `JoinClient` + `RelayServer`; used by both adapters. UI is secondary; relay host/joiner interaction is the contract.

## Explicit non-goals (for now)

- Rebuilding a full coding agent harness from scratch.
- Competing with multi-agent orchestration plugins.
- Making the browser app the primary UX again (optional later for non-OpenCode observers).
- Splitting the monorepo until adapter publish cadence actually diverges.
