import { describe, it, expect, beforeEach } from "vitest";
import { AccessManager, generateToken } from "../src/access/index.js";

describe("generateToken", () => {
  it("produces a 64-char hex string", () => {
    const st = generateToken("sess-1");
    expect(st.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets expiresAt when ttlMs provided", () => {
    const before = Date.now();
    const st = generateToken("sess-1", "edit", 5000);
    expect(st.expiresAt).toBeGreaterThanOrEqual(before + 4990);
  });

  it("embeds the granted role on the token", () => {
    expect(generateToken("sess-1", "admin").grantedRole).toBe("admin");
    expect(generateToken("sess-1", "edit").grantedRole).toBe("edit");
    expect(generateToken("sess-1", "view").grantedRole).toBe("view");
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
      const st = mgr.issueToken("sess-1", "edit", 1); // 1ms TTL
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
      const user = mgr.addUser("u1", "view", "Alice");
      expect(mgr.getUser("u1")).toEqual(user);
      expect(user.status).toBe("active");
      expect(user.displayName).toBe("Alice");
    });

    it("removes a user", () => {
      mgr.addUser("u1", "view", "Alice");
      mgr.removeUser("u1");
      expect(mgr.getUser("u1")).toBeUndefined();
    });

    it("promotes a viewer to collaborator", () => {
      mgr.addUser("u1", "view", "Alice");
      expect(mgr.setRole("u1", "edit")).toBe(true);
      expect(mgr.canSendInput("u1")).toBe(true);
    });

    it("returns false when setting role on unknown user", () => {
      expect(mgr.setRole("ghost", "edit")).toBe(false);
    });

    it("identifies admin correctly", () => {
      mgr.addUser("u1", "admin", "Admin");
      mgr.addUser("u2", "view", "Viewer");
      expect(mgr.isAdmin("u1")).toBe(true);
      expect(mgr.isAdmin("u2")).toBe(false);
    });

    it("canSendInput is true for admin and edit, false for view", () => {
      mgr.addUser("admin", "admin", "A");
      mgr.addUser("collab", "edit", "C");
      mgr.addUser("view", "view", "V");
      expect(mgr.canSendInput("admin")).toBe(true);
      expect(mgr.canSendInput("collab")).toBe(true);
      expect(mgr.canSendInput("view")).toBe(false);
    });

    it("pending users cannot send input until approved", () => {
      mgr.addUser("p1", "edit", "Pat", "pending");
      expect(mgr.canSendInput("p1")).toBe(false);
      expect(mgr.approve("p1")?.status).toBe("active");
      expect(mgr.canSendInput("p1")).toBe(true);
    });

    it("lists all users", () => {
      mgr.addUser("u1", "admin", "A");
      mgr.addUser("u2", "view", "B");
      expect(mgr.listUsers()).toHaveLength(2);
    });
  });
});
