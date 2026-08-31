# Chorus VS Code extension

VS Code adapter for [Chorus](../../README.md) — share or join a live collaborative AI session over `chorus-relay`.

The relay is the core; this extension is a thin client on the same `/host` + `/ws` protocol as the OpenCode terminal plugin (`@chorus/client` + `@chorus/shared`).

## What it does

| Command | Behavior |
|---|---|
| **Chorus: Share Session** | Spawns/attaches `chorus-relay`, sets session policy, issues a join token, copies `/chorus-join …` to the clipboard |
| **Chorus: Join Session** | Connects to `/ws` with token + host (+ optional display name / email) |
| **Chorus: Approve Joiner** / **Deny Joiner** | Host admits or rejects pending joiners (when `chorus.requireApproval` is on) |
| **Chorus: Send Prompt to Host** | Joiner `collab.input` into the shared session |
| **Chorus: Publish Host Message** | Host `session.event` fan-out to joiners |
| **Chorus: Send Chat Message** | Side-channel chat (not LLM history) |
| **Chorus: Leave / Stop / Status** | Disconnect / tear down / inspect state |

The **Chorus** activity-bar panel shows the mirrored transcript and a compose box.

## Cross-adapter relay

Both adapters speak the same wire protocol. Mix and match:

| Host | Joiner | Notes |
|---|---|---|
| OpenCode (terminal) | OpenCode | Primary path — full LLM loop + transcript mirror |
| VS Code | OpenCode | VS Code hosts relay; terminal joiner sends `collab.input` |
| OpenCode | VS Code | Terminal hosts relay; VS Code joiner sends `collab.input` and receives session events |
| VS Code | VS Code | Same relay semantics; neither side drives an LLM unless paired with OpenCode |

When **sharing from VS Code**, collaborator prompts appear in the panel/notifications. Publish host/AI lines manually (**Chorus: Publish Host Message**) or pair with an OpenCode host that owns the model.

When **joining an OpenCode-hosted session**, prompts you send are real `collab.input` and the host transcript streams into the panel.

Verify cross-adapter behavior without a GUI:

```sh
# from repo root
bun run test:vscode-relay-e2e
```

## Session access control

Matches the OpenCode plugin:

- **Required display name** on join (empty names rejected)
- **Host approval** — `chorus.requireApproval` (default `true`); pending joiners trigger Approve/Deny notifications
- **Email domain gate** — set `chorus.allowedEmailDomain` when sharing; joiners set `chorus.email`
- **Repo gate** — when the workspace has a git `origin`, joiners must present the same remote

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
| `chorus.displayName` | OS user | Name shown to peers (required non-empty) |
| `chorus.requireApproval` | `true` | Hold joiners in pending until Approve/Deny |
| `chorus.email` | — | Joiner email sent on auth (for email domain gate) |
| `chorus.allowedEmailDomain` | — | When sharing, require joiners at this domain |
| `chorus.relayBin` | — | Path to `chorus-relay` |
| `chorus.publicHost` | LAN IP:port | Advertised join host |

Env vars from the root README (`CHORUS_RELAY_HOST`, `CHORUS_HOST_TOKEN`, `CHORUS_EXTERNAL_RELAY`, network allowlists, …) still apply for Docker/external relays.

## Testing

```sh
bun run test:vscode-e2e           # email gate, pending approve, collab.input
bun run test:vscode-relay-e2e     # three-env gate + VS Code ↔ terminal cross-adapter
```

Multi-machine three-env roles: set `CHORUS_E2E_ROLE` to `host-vscode`, `joiner-vscode`, or `disallowed-joiner` (see root [README](../../README.md#adapter--relay-e2e-no-gui)).

## Layout

```
packages/vscode/
  src/extension.ts      # activate + commands
  src/controller.ts     # JoinClient + RelayServer orchestration
  src/sessionView.ts    # sidebar webview
  src/format.ts         # transcript line formatting
  src/git.ts            # repo remote detection for repo gate
```
