export type UserRole = "admin" | "edit" | "view";
/** Admission state: pending awaits host approve/deny; active may participate. */
export type UserStatus = "pending" | "active";
export interface SessionToken {
    token: string;
    sessionId: string;
    createdAt: number;
    expiresAt?: number;
    grantedRole: UserRole;
}
export interface ConnectedUser {
    userId: string;
    role: UserRole;
    joinedAt: number;
    displayName: string;
    status: UserStatus;
}
export interface SessionEvent {
    id: string;
    sessionId: string;
    type: string;
    payload: unknown;
    timestamp: number;
}
export interface ChatMessage {
    id: string;
    sessionId: string;
    userId: string;
    displayName?: string;
    content: string;
    timestamp: number;
}
export interface SessionSnapshot {
    sessionId: string;
    projectId?: string;
    events: SessionEvent[];
    messages: ChatMessage[];
    startedAt: number;
    endedAt?: number;
    metadata?: Record<string, unknown>;
}
export interface BackupMeta {
    backupId: string;
    sessionId: string;
    createdAt: number;
    eventCount: number;
}
export interface ShareInfo {
    url: string;
    token: string;
    sessionId: string;
    port: number;
}
/** Session admission / binding policy set by the host plugin. */
export interface SessionPolicy {
    requireApproval: boolean;
    /** Normalized or raw host git remote; absent/empty means no repo gate. */
    repoRemote?: string;
}
//# sourceMappingURL=types.d.ts.map