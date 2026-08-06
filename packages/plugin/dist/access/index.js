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
    addUser(userId, role, displayName) {
        const user = { userId, role, joinedAt: Date.now(), displayName };
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
    listUsers() {
        return [...this.users.values()];
    }
    isAdmin(userId) {
        return this.users.get(userId)?.role === "admin";
    }
    canSendInput(userId) {
        const role = this.users.get(userId)?.role;
        return role === "admin" || role === "edit";
    }
}
//# sourceMappingURL=index.js.map