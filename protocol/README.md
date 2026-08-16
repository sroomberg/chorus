# Chorus wire protocol

Canonical JSON examples for the joiner (`/ws`) and host-control (`/host`) contracts.

Hand-written TypeScript types live in `@chorus/shared`. Hand-written Rust types live in `crates/chorus-relay`. Both sides **must** deserialize every fixture in [`fixtures.json`](./fixtures.json) — that file is the shared artifact that prevents drift.

## Surfaces

| Channel | Direction | Types |
|---|---|---|
| `/ws` | relay → joiner | `serverMessages` |
| `/ws` | joiner → relay | `clientMessages` |
| `/host` | plugin → relay | `hostToRelay` |
| `/host` | relay → plugin | `relayToHost` |

Field names on the wire are **camelCase** (`sessionId`, `userId`, `displayName`, …). Discriminator is always `type`.

## Access control (v1)

- Joiner `auth` requires a non-empty `displayName`.
- Optional `repoRemote` on `auth` is compared (normalized) to host `session.policy.repoRemote` when set.
- When `session.policy.requireApproval` is true, joiners receive `auth.pending` until the host sends `host.approve` / `host.deny`.

## Changing the protocol

1. Add or update examples in `fixtures.json`.
2. Update TS types in `packages/shared/src/` and Rust types in `crates/chorus-relay/src/protocol.rs`.
3. Run `bun run test` — fixture suites on both sides must pass.

Codegen can replace the hand-written types later; the fixtures stay the contract.
