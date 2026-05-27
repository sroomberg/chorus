# chorus

Collaborative OpenCode session sharing. Watch and pair-program AI sessions in real time.

## What it does

- **Session viewing** — share a live link so others can watch your OpenCode session
- **Pair programming** — promote viewers to collaborators who can send messages to the LLM
- **Live chat** — sidebar chat channel alongside the session stream
- **Cloud backup** — archive sessions to S3/R2 for later review

## How it works

Chorus is an [OpenCode](https://github.com/sst/opencode) plugin. It hooks into the session event stream and runs a companion web server that lets others observe (and optionally interact with) your session via a browser.

```
Host runs opencode → plugin loads automatically
Host runs: /share   → generates session URL + token
Others open URL     → watch session live in browser
Host promotes user  → collaborator can send LLM messages
```

## Installation

```sh
# In your OpenCode project directory
mkdir -p .opencode/plugin
bun add --cwd .opencode/plugin @chorus/plugin
```

Then add to `.opencode/config.json`:
```json
{
  "plugins": ["@chorus/plugin"]
}
```

## Packages

| Package | Description |
|---|---|
| `packages/plugin` | OpenCode plugin — hooks, relay server, access control, backup |
| `packages/web` | React companion web app (Xterm.js + chat sidebar) |
| `packages/shared` | Shared TypeScript types and WebSocket protocol |

## Development

```sh
bun install
bun run build
bun run test
bun run dev
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CHORUS_PORT` | `7742` | Port for the companion web server |
| `CHORUS_AWS_BUCKET` | — | S3/R2 bucket for session backup |
| `CHORUS_AWS_REGION` | `us-east-1` | AWS region |
| `CHORUS_AWS_ENDPOINT` | — | Custom endpoint (for R2/MinIO) |

## License

MIT
