import type { SessionEvent, SessionToken, UserRole } from "@chorus/shared";
export type RelayServerOptions = {
    /** Host running the relay (default 127.0.0.1). */
    host?: string;
    /** When set with external mode, attach instead of spawning. */
    hostToken?: string;
    /**
     * Attach to an already-running relay (e.g. on the Docker host).
     * When true, requires hostToken and does not spawn/kill a subprocess.
     */
    external?: boolean;
};
/**
 * Resolve relay connection settings from env.
 *
 * External attach (relay already running elsewhere):
 *   CHORUS_RELAY_HOST=host.docker.internal:7742
 *   CHORUS_HOST_TOKEN=<shared secret>
 *   CHORUS_EXTERNAL_RELAY=1   (optional; implied when HOST_TOKEN is set)
 */
export declare function relayOptionsFromEnv(defaultPort: number): {
    port: number;
    opts: RelayServerOptions;
};
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
    private readonly host;
    private readonly external;
    private pendingToken;
    private onInjectInput?;
    private onChatMessage?;
    private onTyping?;
    constructor(port: number, opts?: RelayServerOptions);
    setInputHandler(fn: (content: string, userId: string, displayName?: string) => Promise<void>): void;
    setChatHandler(fn: (displayName: string | undefined, content: string) => void): void;
    setTypingHandler(fn: (displayName: string | undefined) => void): void;
    start(): Promise<void>;
    private statusUrl;
    private hostWsUrl;
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
    getHost(): string;
    isExternal(): boolean;
}
//# sourceMappingURL=index.d.ts.map