import type { SessionToken, ConnectedUser, UserRole } from "@chorus/shared";
export declare function generateToken(sessionId: string, role?: UserRole, ttlMs?: number): SessionToken;
export declare class AccessManager {
    private tokens;
    private users;
    issueToken(sessionId: string, role?: UserRole, ttlMs?: number): SessionToken;
    validateToken(token: string): SessionToken | null;
    revokeToken(token: string): void;
    addUser(userId: string, role: UserRole, displayName?: string): ConnectedUser;
    removeUser(userId: string): void;
    getUser(userId: string): ConnectedUser | undefined;
    setRole(userId: string, role: UserRole): boolean;
    listUsers(): ConnectedUser[];
    isAdmin(userId: string): boolean;
    canSendInput(userId: string): boolean;
}
//# sourceMappingURL=index.d.ts.map