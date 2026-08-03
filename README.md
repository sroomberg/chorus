# chorus

Collaborative OpenCode session sharing. Pair-program a live AI session from another OpenCode instance in real time.

## What it does

- **Session sharing** — host runs `/chorus-share` and sends a join command to a collaborator
- **Pair programming** — joiners with `edit` (default) can send prompts into the host’s LLM session
- **Live chat** — `/chorus-chat` side channel via temporary TUI toasts (does not pollute session history)
- **Cloud backup** — optional archive of session events to S3/R2

## How it works

Chorus is an [OpenCode](https://github.com/sst/opencode) plugin. It hooks into the session event stream and runs an embedded Bun WebSocket relay so other OpenCode users can join.

```
Host runs opencode          → plugin loads automatically
Host runs: /chorus-share    → starts relay + issues join token
Joiner runs: /chorus-join   → connects over WebSocket
Joiner prompts              → forwarded into the host session
Host promotes / roles       → edit (default) · view · admin  (host tools still TODO — see docs/STATUS.md)
```

Both sides need OpenCode + the chorus plugin. There is no browser companion in the current design (removed after early experiments).

## Installation

Until packages are published to npm, install from this repo (or a path/git checkout):

```sh
# From a clone of this repo, link into your OpenCode plugin dir
mkdir -p .opencode/plugin
bun add --cwd .opencode/plugin /path/to/chorus/packages/plugin
```

Then add to `.opencode/config.json` / `opencode.json`:

```json
{
  "plugin": ["@chorus/plugin"]
}
```

Slash commands (`/chorus-share`, `/chorus-join`, etc.) are copied into `~/.config/opencode/commands/` on first plugin load.

## Packages

| Package | Description |
|---|---|
| `packages/plugin` | OpenCode plugin — hooks, relay server, access control, join client, backup |
| `packages/shared` | Shared TypeScript types and WebSocket protocol |

## Development

```sh
bun install
bun run build
bun run test
bun run typecheck
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CHORUS_PORT` | `7742` | Port for the relay server (binds `0.0.0.0` for LAN) |
| `CHORUS_AWS_BUCKET` | — | S3/R2 bucket for session backup |
| `CHORUS_AWS_REGION` | `us-east-1` | AWS region |
| `CHORUS_AWS_ENDPOINT` | — | Custom endpoint (for R2/MinIO) |

Remote tunneling (`bore` / `cloudflared`) is not implemented yet — share a LAN IP + port for now.

## Roadmap & decisions

- [docs/STATUS.md](docs/STATUS.md) — what’s done and what still needs to happen
- [docs/DECISIONS.md](docs/DECISIONS.md) — OpenCode plugin vs from-scratch, languages, license

## License

MIT
