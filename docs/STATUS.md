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

5. **Joiner dual-session bug**: joiner prompts still hit the *local* LLM *and* the host → sessions diverge. Need suppress/noReply on the joiner turn, or a read-only joiner mode that only forwards.
6. ~~**True session viewing**~~: host prompts + AI replies are injected into the joiner OpenCode transcript (`[Host]:` / `[AI]:`, history replayed on join). Still labeled user-lines (OpenCode has no plugin API for true assistant turns); chat/typing stay toasts. Guard: same agent cannot share and join (that mirrored AI replies back into the host and looped).
7. **Host moderation tools**: protocol has `host.promote|demote|kick|close`, but the host is not a WS client, so those controls are unreachable. Add `chorus-promote` / `chorus-kick` (etc.) as host-side tools.

### P1 — remote use & security

8. Implement `tunnel/` (`bore` / `cloudflared`) or explicitly market LAN-only.
9. Default token TTL; revoke tokens on `chorus-stop`.
10. TLS / auth hardening for off-LAN; protocol decode is bare `JSON.parse`.

### P1 — reliability

11. Serialize collab input injection (current “queue” can race).
12. JoinClient reconnect + connect timeout.
13. Replay chat history on join (events only today).
14. Refresh installed slash commands on plugin upgrade (today: skip if dest exists).

### P2 — backup & polish

15. Backup AI + chat events; expose restore/list; set `endedAt` on stop.
16. Drop unused `@aws-sdk/lib-storage` or use it.
17. Broader tests: roles/view-forbid, kick/close, chat/typing, plugin entry, tunnel.
18. Native slash-command registration when [opencode#5305](https://github.com/sst/opencode/issues/5305) lands.

## Local multi-agent harness

`scripts/multi-agent.ts` (via `bun run multi-agent`) can spawn N isolated `opencode serve` instances with the Chorus plugin, then automate `/chorus-share` + `/chorus-join` through OpenCode’s `/session/:id/command` API. Also includes `relay-stress` for concurrent protocol joiners without OpenCode.

## Explicit non-goals (for now)

- Rebuilding a full coding agent harness from scratch.
- Competing with multi-agent orchestration plugins.
- Making the browser app the primary UX again (optional later for non-OpenCode observers).
