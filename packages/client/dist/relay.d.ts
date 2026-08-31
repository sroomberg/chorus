import type { ConnectedUser, SessionEvent, SessionToken, UserRole } from "@chorus/shared";
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
    /** Bind address passed to chorus-relay (default 0.0.0.0). */
    bind?: string;
    /** CIDR/IP allowlist for TCP peers. */
    allowedCidrs?: string[];
    /** Explicit deny CIDRs (deny wins). */
    deniedCidrs?: string[];
    /** Peer source-port allowlist (single-machine e2e). */
    allowedPorts?: number[];
    /** Refuse 0.0.0.0 / :: bind when false. */
    allowOpenBind?: boolean;
    /** Admit loopback IPs even when allowlist is set (default true). */
    allowLoopback?: boolean;
};
export type RelayNetworkOptions = {
    bind?: string;
    allowedCidrs?: string[];
    deniedCidrs?: string[];
    allowedPorts?: number[];
    allowOpenBind?: boolean;
    allowLoopback?: boolean;
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
 * Joiner-facing protocol on `/ws` is unchanged; host adapters talk to `/host`.
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
    private bind;
    private allowedCidrs;
    private deniedCidrs;
    private allowedPorts;
    private allowOpenBind;
    private allowLoopback;
    private pendingToken;
    private onInjectInput?;
    private onChatMessage?;
    private onTyping?;
    private onUserPending?;
    private onUserJoined?;
    private onUserLeft?;
    constructor(port: number, opts?: RelayServerOptions);
    /** Apply network policy before start() (from project/org chorus.json). */
    setNetworkOptions(opts: RelayNetworkOptions): void;
    setInputHandler(fn: (content: string, userId: string, displayName?: string) => Promise<void>): void;
    setChatHandler(fn: (displayName: string | undefined, content: string) => void): void;
    setTypingHandler(fn: (displayName: string | undefined) => void): void;
    setUserPendingHandler(fn: (user: ConnectedUser) => void): void;
    setUserJoinedHandler(fn: (user: ConnectedUser) => void): void;
    setUserLeftHandler(fn: (userId: string) => void): void;
    start(): Promise<void>;
    private statusUrl;
    private hostWsUrl;
    private waitForPort;
    private connectHost;
    private handleHostMessage;
    private send;
    issueToken(sessionId: string, role?: UserRole, ttlMs?: number): Promise<SessionToken>;
    setSessionPolicy(opts: {
        requireApproval?: boolean;
        repoRemote?: string | null;
        allowedEmailDomain?: string | null;
        additionalRepoRemotePrefixes?: string[] | null;
        repoRemoteRewrites?: {
            from: string;
            to: string;
        }[] | null;
    }): void;
    approveUser(userId: string): void;
    denyUser(userId: string): void;
    kickUser(userId: string): void;
    pushEvent(event: SessionEvent): void;
    sendChat(displayName: string | undefined, content: string): void;
    stop(): Promise<void>;
    private waitUntilStopped;
    get isRunning(): boolean;
    get clientCount(): number;
    getPort(): number;
    getHost(): string;
    getBind(): string;
    getAllowedCidrs(): string[];
    isExternal(): boolean;
}
//# sourceMappingURL=relay.d.ts.map