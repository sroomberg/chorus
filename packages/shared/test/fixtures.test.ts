import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeServerMessage,
  decodeClientMessage,
  encodeMessage,
} from "../src/protocol.js";
import { decodeRelayToHost, encodeHostMessage } from "../src/host.js";
import type { HostToRelay } from "../src/host.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = JSON.parse(
  readFileSync(join(root, "protocol/fixtures.json"), "utf8")
) as {
  serverMessages: unknown[];
  clientMessages: unknown[];
  hostToRelay: HostToRelay[];
  relayToHost: unknown[];
};

describe("protocol fixtures (shared with Rust)", () => {
  it("deserializes every serverMessage", () => {
    for (const raw of fixtures.serverMessages) {
      const encoded = JSON.stringify(raw);
      expect(decodeServerMessage(encoded)).toEqual(raw);
      expect(JSON.parse(encodeMessage(decodeServerMessage(encoded)))).toEqual(raw);
    }
  });

  it("deserializes every clientMessage", () => {
    for (const raw of fixtures.clientMessages) {
      const encoded = JSON.stringify(raw);
      expect(decodeClientMessage(encoded)).toEqual(raw);
      expect(JSON.parse(encodeMessage(decodeClientMessage(encoded)))).toEqual(raw);
    }
  });

  it("deserializes every hostToRelay", () => {
    for (const raw of fixtures.hostToRelay) {
      expect(JSON.parse(encodeHostMessage(raw))).toEqual(raw);
    }
  });

  it("deserializes every relayToHost", () => {
    for (const raw of fixtures.relayToHost) {
      const encoded = JSON.stringify(raw);
      expect(decodeRelayToHost(encoded)).toEqual(raw);
    }
  });
});
