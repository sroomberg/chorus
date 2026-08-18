import type { SessionToken, ConnectedUser, UserRole, UserStatus } from "@chorus/shared";
import { randomBytes } from "node:crypto";

export function generateToken(
  sessionId: string,
  role: UserRole = "edit",
  ttlMs?: number
): SessionToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    sessionId,
    createdAt: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    grantedRole: role,
  };
}

export class AccessManager {
  private tokens = new Map<string, SessionToken>();
  private users = new Map<string, ConnectedUser>();

  issueToken(sessionId: string, role: UserRole = "edit", ttlMs?: number): SessionToken {
    const st = generateToken(sessionId, role, ttlMs);
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

  addUser(
    userId: string,
    role: UserRole,
    displayName: string,
    email?: string,
    status: UserStatus = "active"
  ): ConnectedUser {
    const user: ConnectedUser = {
      userId,
      role,
      joinedAt: Date.now(),
      displayName,
      ...(email ? { email } : {}),
      status,
    };
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

  approve(userId: string): ConnectedUser | null {
    const user = this.users.get(userId);
    if (!user || user.status !== "pending") return null;
    user.status = "active";
    return user;
  }

  isPending(userId: string): boolean {
    return this.users.get(userId)?.status === "pending";
  }

  isActive(userId: string): boolean {
    return this.users.get(userId)?.status === "active";
  }

  listUsers(): ConnectedUser[] {
    return [...this.users.values()];
  }

  listActiveUsers(): ConnectedUser[] {
    return [...this.users.values()].filter((u) => u.status === "active");
  }

  isAdmin(userId: string): boolean {
    const user = this.users.get(userId);
    return user?.role === "admin" && user.status === "active";
  }

  canSendInput(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user || user.status !== "active") return false;
    return user.role === "admin" || user.role === "edit";
  }
}
