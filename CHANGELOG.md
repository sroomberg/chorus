# Changelog

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
