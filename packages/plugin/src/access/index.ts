import type { SessionToken, ConnectedUser, UserRole } from "@chorus/shared";
import { randomBytes } from "node:crypto";

export function generateToken(sessionId: string, ttlMs?: number): SessionToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    sessionId,
    createdAt: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
  };
}

export class AccessManager {
  private tokens = new Map<string, SessionToken>();
  private users = new Map<string, ConnectedUser>();

  issueToken(sessionId: string, ttlMs?: number): SessionToken {
    const st = generateToken(sessionId, ttlMs);
    this.tokens.set(st.token, st);
    return st;
  }

  validateToken(token: string): SessionToken | null {
    const st = this.tokens.get(token);
    if (!st) return null;
    if (st.expiresAt && Date.now() > st.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return st;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  addUser(userId: string, role: UserRole, displayName?: string): ConnectedUser {
    const user: ConnectedUser = { userId, role, joinedAt: Date.now(), displayName };
    this.users.set(userId, user);
    return user;
  }

  removeUser(userId: string): void {
    this.users.delete(userId);
  }

  getUser(userId: string): ConnectedUser | undefined {
    return this.users.get(userId);
  }

  setRole(userId: string, role: UserRole): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    user.role = role;
    return true;
  }

  listUsers(): ConnectedUser[] {
    return [...this.users.values()];
  }

  isHost(userId: string): boolean {
    return this.users.get(userId)?.role === "host";
  }

  canSendInput(userId: string): boolean {
    const role = this.users.get(userId)?.role;
    return role === "host" || role === "collaborator";
  }
}
