# Chorus VS Code extension

VS Code adapter for [Chorus](../../README.md) — share or join a live collaborative AI session over `chorus-relay`.

## What it does

| Command | Behavior |
|---|---|
| **Chorus: Share Session** | Spawns/attaches `chorus-relay`, issues a join token, copies `/chorus-join …` to the clipboard |
| **Chorus: Join Session** | Connects to `/ws` with token + host |
| **Chorus: Send Prompt to Host** | Joiner `collab.input` into the shared session |
| **Chorus: Publish Host Message** | Host `session.event` fan-out to joiners |
| **Chorus: Send Chat Message** | Side-channel chat (not LLM history) |
| **Chorus: Leave / Stop / Status** | Disconnect / tear down / inspect state |

The **Chorus** activity-bar panel shows the mirrored transcript and a compose box.

## Honest scope (v1)

- Speaks the same wire protocol as the OpenCode plugin (`@chorus/shared` + `@chorus/client`).
- VS Code is **not** an OpenCode host: it does not drive OpenCode’s LLM loop. When you **share** from VS Code, collaborator prompts appear in the panel/notifications; publish host/AI lines manually (or pair with an OpenCode host that owns the model).
- When you **join** an OpenCode-hosted session, prompts you send are real `collab.input` and the host transcript streams into the panel.

## Prerequisites

```sh
# from repo root
cargo build -p chorus-relay --release
bun install
bun run build:ts
```

Ensure `chorus-relay` is on `PATH`, or set `chorus.relayBin` / `CHORUS_RELAY_BIN`.

## Install (dev)

1. Build this package: `bun run --filter chorus build`
2. In VS Code: **Extensions: Install from Location…** → select `packages/vscode`  
   (or use the [VS Code Extension Development Host](https://code.visualstudio.com/api/get-started/your-first-extension) with this folder as the extension root)
3. Command Palette → **Chorus: Share Session** / **Join Session**

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `chorus.port` | `7742` | Relay listen port when sharing |
| `chorus.displayName` | OS user | Name shown to peers |
| `chorus.relayBin` | — | Path to `chorus-relay` |
| `chorus.publicHost` | LAN IP:port | Advertised join host |

Env vars from the root README (`CHORUS_RELAY_HOST`, `CHORUS_HOST_TOKEN`, `CHORUS_EXTERNAL_RELAY`, …) still apply for Docker/external relays.

## Layout

```
packages/vscode/
  src/extension.ts      # activate + commands
  src/controller.ts     # JoinClient + RelayServer orchestration
  src/sessionView.ts    # sidebar webview
  src/format.ts         # transcript line formatting
```
