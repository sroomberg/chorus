import type { SessionEvent, ConnectedUser } from "@chorus/shared";
export type JoinStatus = "connecting" | "pending" | "connected" | "disconnected" | "error";
export interface JoinState {
    status: JoinStatus;
    sessionId: string;
    userId?: string;
    users: ConnectedUser[];
    recentEvents: SessionEvent[];
    error?: string;
}
export declare class JoinClient {
    private readonly relayUrl;
    private readonly token;
    private readonly displayName;
    private readonly repoRemote?;
    private ws;
    private state;
    private onEvent?;
    private onChatMessage?;
    private onTyping?;
    private onPending?;
    private onApproved?;
    constructor(relayUrl: string, token: string, displayName: string, repoRemote?: string | undefined);
    connect(): Promise<void>;
    sendInput(content: string): void;
    sendChat(content: string): void;
    setChatHandler(fn: (displayName: string | undefined, content: string) => void): void;
    setTypingHandler(fn: (displayName: string | undefined) => void): void;
    setEventHandler(fn: (event: SessionEvent) => void): void;
    setPendingHandler(fn: (userId: string) => void): void;
    setApprovedHandler(fn: () => void): void;
    sendTyping(): void;
    getState(): Readonly<JoinState>;
    disconnect(): void;
}
//# sourceMappingURL=join.d.ts.map