import { describe, it, expect, beforeEach } from "vitest";
import { AccessManager, generateToken } from "../src/access/index.js";

describe("generateToken", () => {
  it("produces a 64-char hex string", () => {
    const st = generateToken("sess-1");
    expect(st.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets expiresAt when ttlMs provided", () => {
    const before = Date.now();
    const st = generateToken("sess-1", 5000);
    expect(st.expiresAt).toBeGreaterThanOrEqual(before + 4990);
  });

  it("leaves expiresAt undefined when no ttl", () => {
    const st = generateToken("sess-1");
    expect(st.expiresAt).toBeUndefined();
  });
});

describe("AccessManager", () => {
  let mgr: AccessManager;
  beforeEach(() => {
    mgr = new AccessManager();
  });

  describe("tokens", () => {
    it("issues and validates a token", () => {
      const st = mgr.issueToken("sess-1");
      expect(mgr.validateToken(st.token)).toMatchObject({ sessionId: "sess-1" });
    });

    it("returns null for unknown token", () => {
      expect(mgr.validateToken("bad")).toBeNull();
    });

    it("returns null and cleans up expired token", async () => {
      const st = mgr.issueToken("sess-1", 1); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      expect(mgr.validateToken(st.token)).toBeNull();
      // Second call also null (already cleaned up)
      expect(mgr.validateToken(st.token)).toBeNull();
    });

    it("revokes a token", () => {
      const st = mgr.issueToken("sess-1");
      mgr.revokeToken(st.token);
      expect(mgr.validateToken(st.token)).toBeNull();
    });
  });

  describe("users", () => {
    it("adds and retrieves a user", () => {
      const user = mgr.addUser("u1", "viewer", "Alice");
      expect(mgr.getUser("u1")).toEqual(user);
    });

    it("removes a user", () => {
      mgr.addUser("u1", "viewer");
      mgr.removeUser("u1");
      expect(mgr.getUser("u1")).toBeUndefined();
    });

    it("promotes a viewer to collaborator", () => {
      mgr.addUser("u1", "viewer");
      expect(mgr.setRole("u1", "collaborator")).toBe(true);
      expect(mgr.canSendInput("u1")).toBe(true);
    });

    it("returns false when setting role on unknown user", () => {
      expect(mgr.setRole("ghost", "collaborator")).toBe(false);
    });

    it("identifies host correctly", () => {
      mgr.addUser("u1", "host");
      mgr.addUser("u2", "viewer");
      expect(mgr.isHost("u1")).toBe(true);
      expect(mgr.isHost("u2")).toBe(false);
    });

    it("canSendInput is true for host and collaborator, false for viewer", () => {
      mgr.addUser("host", "host");
      mgr.addUser("collab", "collaborator");
      mgr.addUser("view", "viewer");
      expect(mgr.canSendInput("host")).toBe(true);
      expect(mgr.canSendInput("collab")).toBe(true);
      expect(mgr.canSendInput("view")).toBe(false);
    });

    it("lists all users", () => {
      mgr.addUser("u1", "host");
      mgr.addUser("u2", "viewer");
      expect(mgr.listUsers()).toHaveLength(2);
    });
  });
});
