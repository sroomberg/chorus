# Chorus VS Code extension

VS Code adapter for [Chorus](../../README.md) — share or join a live collaborative AI session over `chorus-relay`.

## What it does

| UI / command | Behavior |
|---|---|
| **Chorus** activity bar → **Relay** | Start/stop the relay, copy the join command, approve/deny joiners, join another host |
| **Chorus: Open Chat Window** | Side-channel chat in its own window |
| **Chorus: Open Agent Window** | Shared session / prompts in its own window; **Insert at cursor** into the host editor |
| **Chorus: Share Session** | Same as Start relay; also opens chat + agent windows |

The **host editor** stays in the original VS Code window. Chat and Agent are moved to separate windows so you can keep code in front.

## Access control

Matches the OpenCode plugin defaults:

- Start relay sets `session.policy` with `requireApproval` (setting `chorus.requireApproval`, default `true`) and the workspace `origin` remote when present
- Pending joiners appear in the Relay panel (Approve / Deny)
- Join requires a non-empty display name and sends the workspace git remote for same-repo gating
- While `pending`, prompts/chat are blocked until the host approves

## Honest scope

- Speaks the same wire protocol as the OpenCode plugin (`@chorus/shared` + `@chorus/client`).
- VS Code is **not** an OpenCode host: it does not drive OpenCode’s LLM loop. Collaborator prompts show in the Agent window; publish host/AI lines from that window, or pair with an OpenCode host that owns the model.
- Joiners **cannot type in the host’s files**. They chat and send `collab.input`. The host applies work in their own editor (including Insert at cursor). Remote-control / Live Share-style editing is out of scope for this protocol.

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
2. Open an Extension Development Host with `packages/vscode`, or **Extensions: Install from Location…**
3. Open the Chorus activity bar → **Start relay**, or Command Palette → **Chorus: Share Session**

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
  src/extension.ts               # activate + commands
  src/controller.ts              # JoinClient + RelayServer orchestration
  src/relayView.ts               # sidebar relay manager
  src/collaborationWindows.ts    # chat + agent editor panels
  src/ui.ts                      # shared webview HTML helpers
  src/format.ts                  # transcript line formatting
```
