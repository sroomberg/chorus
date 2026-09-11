# @sroomberg/chorus-shared

Shared TypeScript types and JSON wire-protocol codecs for [Chorus](https://github.com/sroomberg/chorus).

Chorus is collaborative OpenCode session sharing over a Rust WebSocket relay (`chorus-relay`). This package is the contract both sides of the wire use: joiner `/ws` messages, host control-plane `/host` messages, and shared domain types.

## Install

```sh
npm i @sroomberg/chorus-shared
```

You typically depend on this indirectly via `@sroomberg/chorus-client` or `@sroomberg/chorus-plugin`. Import it directly when building a new host or joiner adapter.

## Exports

**Types** (`types.ts`): `UserRole`, `ConnectedUser`, `SessionEvent`, `SessionToken`, `ShareInfo`, `SessionPolicy`, and related shapes.

**Joiner protocol** (`protocol.ts`):

- `ServerMessage` / `ClientMessage` — messages on relay `/ws`
- `encodeMessage`, `decodeServerMessage`, `decodeClientMessage`
- `normalizeDisplayName`, `normalizeEmail`, `emailMatchesDomain`

**Host control plane** (`host.ts`):

- `HostToRelay` / `RelayToHost` — messages on relay `/host`
- `encodeHostMessage`, `decodeRelayToHost`

**Repo matching** (`repo.ts`): helpers for git-remote gates used during join.

## Example

```ts
import {
  encodeMessage,
  decodeServerMessage,
  type ClientMessage,
} from "@sroomberg/chorus-shared";

const auth: ClientMessage = {
  type: "auth",
  token: "...",
  displayName: "Alex",
};
ws.send(encodeMessage(auth));

const msg = decodeServerMessage(raw);
if (msg.type === "session.event") {
  console.log(msg.event);
}
```

## Monorepo

Source, fixtures, and relay binary: [github.com/sroomberg/chorus](https://github.com/sroomberg/chorus)

## License

MIT
