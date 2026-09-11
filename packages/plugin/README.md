# @sroomberg/chorus-plugin

OpenCode plugin for [Chorus](https://github.com/sroomberg/chorus) — collaborative session sharing over `chorus-relay`.

The host runs `/chorus-share` to start a relay and issue a join token; collaborators run `/chorus-join` to mirror the host transcript and send prompts into the shared LLM session.

## Install

```sh
npm i @sroomberg/chorus-plugin
```

Build the relay binary (from the monorepo or a release):

```sh
cargo build -p chorus-relay --release
```

Add to OpenCode config (`opencode.json` or project config):

```json
{
  "plugin": ["@sroomberg/chorus-plugin"]
}
```

The plugin also ships slash-command markdown under `commands/` (e.g. `/chorus-share`, `/chorus-join`).

## Tools

| Tool | Purpose |
|---|---|
| `chorus-share` | Start relay, set session policy, issue join token |
| `chorus-join` | Connect to a shared session as joiner |
| `chorus-approve` / `chorus-deny` | Admit or reject pending joiners |
| `chorus-kick` | Disconnect an active joiner |
| `chorus-leave` | Leave a joined session |
| `chorus-chat` | Side-channel chat (toast notifications) |
| `chorus-status` | Sharing/join state and config |
| `chorus-stop` | Stop sharing |

Configuration merges from `chorus.json` (org/user/project scopes). See the [monorepo README](https://github.com/sroomberg/chorus#readme) for relay env vars (`CHORUS_PORT`, `CHORUS_RELAY_HOST`, `CHORUS_HOST_TOKEN`, …) and security options.

## How it fits

```
OpenCode host  →  @sroomberg/chorus-plugin  →  RelayServer (/host)  →  chorus-relay
OpenCode joiner →  @sroomberg/chorus-plugin  →  JoinClient (/ws)      →  chorus-relay
```

Wire types and codecs: `@sroomberg/chorus-shared`. Relay spawn/attach and clients: `@sroomberg/chorus-client`.

## Monorepo

Source, VS Code adapter, protocol fixtures, and relay: [github.com/sroomberg/chorus](https://github.com/sroomberg/chorus)

## License

MIT
