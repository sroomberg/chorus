import { describe, it, expect } from "vitest";
import {
  encodeMessage,
  decodeServerMessage,
  decodeClientMessage,
} from "../src/protocol.js";
import type { ServerMessage, ClientMessage } from "../src/protocol.js";

describe("encodeMessage / decodeServerMessage", () => {
  it("round-trips a session.event message", () => {
    const msg: ServerMessage = {
      type: "session.event",
      event: {
        id: "evt-1",
        sessionId: "sess-abc",
        type: "message.created",
        payload: { text: "hello" },
        timestamp: 1000,
      },
    };
    const decoded = decodeServerMessage(encodeMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it("round-trips a user.list message", () => {
    const msg: ServerMessage = {
      type: "user.list",
      users: [
        {
          userId: "u1",
          role: "admin",
          joinedAt: 1000,
          displayName: "Host",
          status: "active",
        },
        {
          userId: "u2",
          role: "view",
          joinedAt: 1001,
          displayName: "Bob",
          status: "active",
        },
      ],
    };
    expect(decodeServerMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("round-trips auth.pending", () => {
    const msg: ServerMessage = {
      type: "auth.pending",
      userId: "u2",
      message: "Waiting for host approval",
    };
    expect(decodeServerMessage(encodeMessage(msg))).toEqual(msg);
  });
});

describe("encodeMessage / decodeClientMessage", () => {
  it("round-trips an auth message", () => {
    const msg: ClientMessage = {
      type: "auth",
      token: "abc123",
      displayName: "Alice",
    };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("round-trips a collab.input message", () => {
    const msg: ClientMessage = { type: "collab.input", content: "fix the bug" };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("round-trips a host.promote message", () => {
    const msg: ClientMessage = { type: "host.promote", userId: "u2" };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });
});
