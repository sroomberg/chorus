import type { SessionEvent, SessionToken, UserRole } from "@chorus/shared";
/**
 * Manages the Rust `chorus-relay` subprocess and the host control WebSocket.
 * Joiner-facing protocol on `/ws` is unchanged; the plugin talks to `/host`.
 */
export declare class RelayServer {
    private readonly port;
    private child;
    private ws;
    private hostToken;
    private running;
    private clients;
    private pendingToken;
    private onInjectInput?;
    private onChatMessage?;
    private onTyping?;
    constructor(port: number);
    setInputHandler(fn: (content: string, userId: string, displayName?: string) => Promise<void>): void;
    setChatHandler(fn: (displayName: string | undefined, content: string) => void): void;
    setTypingHandler(fn: (displayName: string | undefined) => void): void;
    start(): Promise<void>;
    private waitForPort;
    private connectHost;
    private handleHostMessage;
    private send;
    issueToken(sessionId: string, role?: UserRole, ttlMs?: number): Promise<SessionToken>;
    pushEvent(event: SessionEvent): void;
    sendChat(displayName: string | undefined, content: string): void;
    stop(): void;
    get isRunning(): boolean;
    get clientCount(): number;
    getPort(): number;
}
//# sourceMappingURL=index.d.ts.map