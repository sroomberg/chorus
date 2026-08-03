import { describe, it, expect } from "vitest";
import { encodeHostMessage, decodeRelayToHost } from "../src/host.js";

describe("host control protocol", () => {
  it("round-trips host.auth", () => {
    const raw = encodeHostMessage({ type: "host.auth", token: "abc" });
    expect(JSON.parse(raw)).toEqual({ type: "host.auth", token: "abc" });
  });

  it("decodes flattened token.issued", () => {
    const msg = decodeRelayToHost(
      JSON.stringify({
        type: "token.issued",
        token: "deadbeef",
        sessionId: "sess-1",
        createdAt: 1,
        grantedRole: "edit",
      })
    );
    expect(msg.type).toBe("token.issued");
    if (msg.type === "token.issued") {
      expect(msg.token).toBe("deadbeef");
      expect(msg.grantedRole).toBe("edit");
    }
  });

  it("decodes collab.input", () => {
    const msg = decodeRelayToHost(
      JSON.stringify({
        type: "collab.input",
        userId: "u1",
        displayName: "Dev",
        content: "hi",
      })
    );
    expect(msg).toMatchObject({ type: "collab.input", content: "hi", displayName: "Dev" });
  });
});
