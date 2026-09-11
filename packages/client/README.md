# @sroomberg/chorus-client

TypeScript client library for [Chorus](https://github.com/sroomberg/chorus) host adapters.

Chorus shares live OpenCode (or VS Code) sessions over `chorus-relay`. This package provides:

- **`JoinClient`** — WebSocket client for joiners on relay `/ws`
- **`RelayServer`** — spawns or attaches to `chorus-relay` and speaks the `/host` control plane

Used by `@sroomberg/chorus-plugin` (OpenCode) and the VS Code extension in the monorepo.

## Install

```sh
npm i @sroomberg/chorus-client
```

Requires the `chorus-relay` binary on `PATH` or at `target/release/chorus-relay` relative to the repo. Override with `CHORUS_RELAY_BIN`.

## JoinClient

Connect a joiner to a shared session:

```ts
import { JoinClient } from "@sroomberg/chorus-client";

const client = new JoinClient(
  "ws://192.168.1.5:7742/ws",
  token,
  "Alex",
  repoRemote, // optional git origin for repo gate
  email       // optional when host requires company domain
);

client.setEventHandler((event) => { /* session.event */ });
client.setApprovedHandler(() => { /* auth approved */ });

await client.connect();
client.sendInput("fix the failing test");
client.sendChat("hello");
client.disconnect();
```

`getState()` exposes `status` (`connecting` | `pending` | `connected` | …), connected users, and buffered `recentEvents`.

## RelayServer

Host-side relay management:

```ts
import { RelayServer, relayOptionsFromEnv } from "@sroomberg/chorus-client";

const { port, opts } = relayOptionsFromEnv(7742);
const relay = new RelayServer(port, opts);

await relay.start();
const { token } = await relay.issueToken(sessionId, "edit");
relay.pushEvent(event);
relay.setInputHandler((content, userId, displayName) => { /* collab.input */ });
await relay.stop();
```

`relayOptionsFromEnv` reads `CHORUS_RELAY_HOST`, `CHORUS_HOST_TOKEN`, and `CHORUS_EXTERNAL_RELAY` for attaching to an external relay (e.g. Docker host).

## Dependencies

Peer types and codecs come from `@sroomberg/chorus-shared`.

## Monorepo

Source, OpenCode plugin, VS Code adapter, and relay: [github.com/sroomberg/chorus](https://github.com/sroomberg/chorus)

## License

MIT
