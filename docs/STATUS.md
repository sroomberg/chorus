# Chorus status — what still needs to happen

Snapshot as of 2026-08-03 (post `v0.1.6`). Tests/typecheck/build are green (33 tests).

## Current state

Chorus is an **OpenCode↔OpenCode** LAN collaboration stack:

- Host: `/chorus-share` → spawns Rust `chorus-relay` + issues token via `/host`
- Joiner: `/chorus-join` → connects to relay `/ws`, forwards prompts into the host session
- Side channel: `/chorus-chat` + typing toasts
- Optional S3/R2 backup of user events

The browser companion (`packages/web`) was intentionally removed. Joiners now mirror the host transcript into their OpenCode session (`[Host]:` / `[AI]:` lines via `noReply` inject); side-channel chat/typing remain toasts.
The in-process Bun relay has been replaced by `crates/chorus-relay`.

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

8. Implement `tunnel/` (`bore` / `cloudflared`) or explicitly market LAN-only.
9. Default token TTL; revoke tokens on `chorus-stop`.
10. TLS / auth hardening for off-LAN; protocol decode is bare `JSON.parse`.
11. Stronger repo ACL (GitHub/GitLab API or signed capability) — current gate is same-remote claim only.
12. Host moderation UI polish (pending queue in `chorus-status`, bulk approve).

### Security shipped (this pass)

- Host approval gate (`requireApproval`, default on for `/chorus-share`; `chorus-approve` / `chorus-deny`)
- Required display name on join (no anonymous / empty names)
- Git origin binding when the host share directory has a remote (joiner must present matching remote)
- `chorus-kick` for active joiners
- Layered `chorus.json` config (org/user/project) for security + relay + backup defaults, with enterprise locks

### P1 — reliability

13. Serialize collab input injection (current “queue” can race).
14. JoinClient reconnect + connect timeout.
15. Replay chat history on join (events only today).
16. Refresh installed slash commands on plugin upgrade (today: skip if dest exists).

### P2 — backup & polish

17. Backup AI + chat events; expose restore/list; set `endedAt` on stop.
18. Drop unused `@aws-sdk/lib-storage` or use it.
19. Broader tests: roles/view-forbid, kick/close, chat/typing, plugin entry, tunnel.
20. Native slash-command registration when [opencode#5305](https://github.com/sst/opencode/issues/5305) lands.

## Local multi-agent harness

`scripts/multi-agent.ts` (via `bun run multi-agent`) can spawn N isolated `opencode serve` instances with the Chorus plugin, then automate `/chorus-share` + `/chorus-join` through OpenCode’s `/session/:id/command` API. Also includes `relay-stress` for concurrent protocol joiners without OpenCode.

## Explicit non-goals (for now)

- Rebuilding a full coding agent harness from scratch.
- Competing with multi-agent orchestration plugins.
- Making the browser app the primary UX again (optional later for non-OpenCode observers).
