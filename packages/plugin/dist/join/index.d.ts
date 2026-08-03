import type { SessionEvent, ConnectedUser } from "@chorus/shared";
export type JoinStatus = "connecting" | "connected" | "disconnected" | "error";
export interface JoinState {
    status: JoinStatus;
    sessionId: string;
    users: ConnectedUser[];
    recentEvents: SessionEvent[];
    error?: string;
}
export declare class JoinClient {
    private readonly relayUrl;
    private readonly token;
    private readonly displayName;
    private ws;
    private state;
    private onEvent?;
    private onChatMessage?;
    private onTyping?;
    constructor(relayUrl: string, token: string, displayName: string);
    connect(): Promise<void>;
    sendInput(content: string): void;
    sendChat(content: string): void;
    setChatHandler(fn: (displayName: string | undefined, content: string) => void): void;
    setTypingHandler(fn: (displayName: string | undefined) => void): void;
    setEventHandler(fn: (event: SessionEvent) => void): void;
    sendTyping(): void;
    getState(): Readonly<JoinState>;
    disconnect(): void;
}
//# sourceMappingURL=index.d.ts.map