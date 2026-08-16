import * as vscode from "vscode";
import { type JoinState } from "@chorus/client";
import type { UserRole } from "@chorus/shared";
export type ChorusMode = "idle" | "sharing" | "joined";
export type TranscriptLine = {
    id: string;
    text: string;
    at: number;
    kind: "session" | "chat" | "system";
};
/**
 * Host/joiner controller for the VS Code adapter.
 * Speaks the same `/host` + `/ws` contracts as the OpenCode plugin.
 */
export declare class ChorusController {
    private readonly output;
    private readonly statusBar;
    private mode;
    private relay;
    private joinClient;
    private sessionId;
    private readonly transcript;
    private readonly _onDidChange;
    readonly onDidChange: vscode.Event<void>;
    constructor(output: vscode.OutputChannel, statusBar: vscode.StatusBarItem);
    getMode(): ChorusMode;
    getTranscript(): readonly TranscriptLine[];
    getJoinState(): JoinState | null;
    getShareSummary(): {
        sharing: boolean;
        clients?: number;
        port?: number;
        host?: string;
        external?: boolean;
    };
    private cfg;
    private displayName;
    private defaultPort;
    private publicJoinHost;
    private append;
    private appendSystem;
    private appendSession;
    private refreshStatus;
    share(role?: UserRole): Promise<string>;
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
