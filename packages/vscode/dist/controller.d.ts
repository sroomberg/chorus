import * as vscode from "vscode";
import { type JoinState } from "@chorus/client";
import type { ConnectedUser, UserRole } from "@chorus/shared";
export type ChorusMode = "idle" | "sharing" | "joined" | "pending";
export type TranscriptLine = {
    id: string;
    text: string;
    at: number;
    kind: "session" | "chat" | "system";
};
/**
 * Host/joiner controller for the VS Code adapter.
 * Speaks the same `/host` + `/ws` contracts as the OpenCode plugin, including
 * session access control (approval, required name, optional repo gate).
 */
export declare class ChorusController {
    private readonly output;
    private readonly statusBar;
    private mode;
    private relay;
    private joinClient;
    private sessionId;
    private pendingUsers;
    private readonly transcript;
    private readonly _onDidChange;
    readonly onDidChange: vscode.Event<void>;
    constructor(output: vscode.OutputChannel, statusBar: vscode.StatusBarItem);
    getMode(): ChorusMode;
    getTranscript(): readonly TranscriptLine[];
    getPendingUsers(): readonly ConnectedUser[];
    getJoinState(): JoinState | null;
    getShareSummary(): {
        sharing: boolean;
        clients?: number;
        port?: number;
        host?: string;
        external?: boolean;
        pending?: number;
    };
    private cfg;
    private displayName;
    private defaultPort;
    private requireApprovalDefault;
    private publicJoinHost;
    private append;
    private appendSystem;
    private appendSession;
    private refreshStatus;
    private ensureRelayHandlers;
    share(role?: UserRole, requireApproval?: boolean): Promise<string>;
    approveUser(userId: string): void;
    denyUser(userId: string): void;
    join(token: string, host: string, name?: string): Promise<void>;
    leave(): Promise<void>;
    stop(): void;
    sendChat(message: string): void;
    /** Joiner → host collab.input */
    sendPrompt(content: string): void;
    /** Host publishes a user/assistant line onto the shared transcript. */
    publishHostMessage(content: string, type?: "user" | "assistant"): void;
    statusText(): string;
    dispose(): void;
}
