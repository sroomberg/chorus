# Changelog

## v0.1.2 — 2026-05-27

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
