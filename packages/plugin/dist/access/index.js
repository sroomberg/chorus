import { randomBytes } from "node:crypto";
export function generateToken(sessionId, role = "edit", ttlMs) {
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
    tokens = new Map();
    users = new Map();
    issueToken(sessionId, role = "edit", ttlMs) {
        const st = generateToken(sessionId, role, ttlMs);
        this.tokens.set(st.token, st);
        return st;
    }
    validateToken(token) {
        const st = this.tokens.get(token);
        if (!st)
            return null;
        if (st.expiresAt && Date.now() > st.expiresAt) {
            this.tokens.delete(token);
            return null;
        }
        return st;
    }
    revokeToken(token) {
        this.tokens.delete(token);
    }
    addUser(userId, role, displayName, email, status = "active") {
        const user = {
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
    removeUser(userId) {
        this.users.delete(userId);
    }
    getUser(userId) {
        return this.users.get(userId);
    }
    setRole(userId, role) {
        const user = this.users.get(userId);
        if (!user)
            return false;
        user.role = role;
        return true;
    }
    approve(userId) {
        const user = this.users.get(userId);
        if (!user || user.status !== "pending")
            return null;
        user.status = "active";
        return user;
    }
    isPending(userId) {
        return this.users.get(userId)?.status === "pending";
    }
    isActive(userId) {
        return this.users.get(userId)?.status === "active";
    }
    listUsers() {
        return [...this.users.values()];
    }
    listActiveUsers() {
        return [...this.users.values()].filter((u) => u.status === "active");
    }
    isAdmin(userId) {
        const user = this.users.get(userId);
        return user?.role === "admin" && user.status === "active";
    }
    canSendInput(userId) {
        const user = this.users.get(userId);
        if (!user || user.status !== "active")
            return false;
        return user.role === "admin" || user.role === "edit";
    }
}
//# sourceMappingURL=index.js.map