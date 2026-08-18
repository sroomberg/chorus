# Changelog

## Unreleased

- Config file support (`chorus.json` / `.chorus/config.json` / `~/.config/chorus/config.json` / `/etc/chorus/config.json`) with layered merge, enterprise security locks (`allowSkipApproval`, `requireRepoMatch`), and `/chorus-status` effective-config output
- Security: host approval gate for joiners (`requireApproval` on share, default true; `chorus-approve` / `chorus-deny`)
- Security: display name required on join (reject empty / whitespace)
- Security: when the host share directory has a git `origin`, bind the session to that remote and reject joiners who are not in a matching clone (soft claim check, not provider ACL)
- Host tool: `chorus-kick` for active joiners
- Real-time shared transcript for all agents: fan out collaborator prompts to every joiner, abort joiner local LLM, mirror `[Host]`/`[name]`/`[AI]` (prefer web UI for live view)
- Joiner mirrors host prompts and AI replies into its OpenCode session transcript (`[Host]:` / `[AI]:`), including history replay on join (replaces toast-only viewing)
- Fix: prevent host/joiner feedback loop when the same agent both shares and joins (block join while sharing; never mirror while hosting; drop echoed `[AI]/`/`[Host]:` collab lines)
- Replace in-process Bun WebSocket relay with Rust `chorus-relay` binary (`crates/chorus-relay`)
- Host control protocol on `/host` (token issue, session events, chat, collab.input fan-in)
- Joiner protocol on `/ws` unchanged
- Plugin spawns/manages the relay subprocess (`CHORUS_RELAY_BIN` override)

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
