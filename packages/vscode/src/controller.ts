import { networkInterfaces } from "node:os";
import * as vscode from "vscode";
import {
  JoinClient,
  RelayServer,
  relayOptionsFromEnv,
  type JoinState,
} from "@chorus/client";
import type { SessionEvent, UserRole } from "@chorus/shared";
import { formatSessionLine, newEventId } from "./format.js";

export type ChorusMode = "idle" | "sharing" | "joined";

export type TranscriptLine = {
  id: string;
  text: string;
  at: number;
  kind: "session" | "chat" | "system";
};

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

/**
 * Host/joiner controller for the VS Code adapter.
 * Speaks the same `/host` + `/ws` contracts as the OpenCode plugin.
 */
export class ChorusController {
  private mode: ChorusMode = "idle";
  private relay: RelayServer | null = null;
  private joinClient: JoinClient | null = null;
  private sessionId = `vscode-${Date.now().toString(36)}`;
  private readonly transcript: TranscriptLine[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem
  ) {
    this.refreshStatus();
  }

  getMode(): ChorusMode {
    return this.mode;
  }

  getTranscript(): readonly TranscriptLine[] {
    return this.transcript;
  }

  getJoinState(): JoinState | null {
    return this.joinClient?.getState() ?? null;
  }

  getShareSummary(): {
    sharing: boolean;
    clients?: number;
    port?: number;
    host?: string;
    external?: boolean;
  } {
    if (!this.relay || this.mode !== "sharing") return { sharing: false };
    return {
      sharing: true,
      clients: this.relay.clientCount,
      port: this.relay.getPort(),
      host: this.relay.getHost(),
      external: this.relay.isExternal(),
    };
  }

  private cfg() {
    return vscode.workspace.getConfiguration("chorus");
  }

  private displayName(): string {
    const configured = this.cfg().get<string>("displayName")?.trim();
    if (configured) return configured;
    return process.env["USER"] ?? process.env["USERNAME"] ?? "vscode";
  }

  private defaultPort(): number {
    return this.cfg().get<number>("port") ?? 7742;
  }

  private publicJoinHost(port: number, relayHost: string, external: boolean): string {
    const fromSettings = this.cfg().get<string>("publicHost")?.trim();
    if (fromSettings) return fromSettings;
    if (process.env["CHORUS_PUBLIC_HOST"]) return process.env["CHORUS_PUBLIC_HOST"];
    if (external && relayHost && relayHost !== "127.0.0.1") {
      return `${relayHost}:${port}`;
    }
    return `${getLanIp()}:${port}`;
  }

  private append(line: TranscriptLine): void {
    this.transcript.push(line);
    if (this.transcript.length > 500) this.transcript.shift();
    this.output.appendLine(line.text);
    this._onDidChange.fire();
  }

  private appendSystem(text: string): void {
    this.append({ id: newEventId(), text, at: Date.now(), kind: "system" });
  }

  private appendSession(event: SessionEvent): void {
    const text = formatSessionLine(event);
    if (!text) return;
    this.append({ id: event.id, text, at: event.timestamp, kind: "session" });
  }

  private refreshStatus(): void {
    if (this.mode === "sharing" && this.relay) {
      this.statusBar.text = `$(broadcast) Chorus sharing :${this.relay.getPort()} (${this.relay.clientCount})`;
      this.statusBar.tooltip = "Chorus is sharing — click for status";
    } else if (this.mode === "joined" && this.joinClient) {
      const st = this.joinClient.getState();
      this.statusBar.text = `$(organization) Chorus joined (${st.users.length})`;
      this.statusBar.tooltip = "Chorus joined — click for status";
    } else {
      this.statusBar.text = "$(circle-slash) Chorus";
      this.statusBar.tooltip = "Chorus idle — Share or Join a session";
    }
    this.statusBar.command = "chorus.status";
    this._onDidChange.fire();
  }

  async share(role: UserRole = "edit"): Promise<string> {
    if (this.mode === "joined") {
      await this.leave();
    }

    const relayBin = this.cfg().get<string>("relayBin")?.trim();
    if (relayBin) process.env["CHORUS_RELAY_BIN"] = relayBin;

    const { port, opts } = relayOptionsFromEnv(this.defaultPort());
    if (!this.relay) {
      this.relay = new RelayServer(port, opts);
      this.relay.setInputHandler(async (content, userId, displayName) => {
        const label = displayName ?? userId.slice(0, 8);
        const labeled = `[${label}]: ${content}`;
        const event: SessionEvent = {
          id: newEventId(),
          sessionId: this.sessionId,
          type: "user",
          payload: labeled,
          timestamp: Date.now(),
        };
        this.appendSession(event);
        this.relay?.pushEvent(event);
        void vscode.window.showInformationMessage(`Chorus prompt from ${label}: ${content}`);
      });
      this.relay.setChatHandler((name, content) => {
        const text = `💬 [${name ?? "guest"}]: ${content}`;
        this.append({ id: newEventId(), text, at: Date.now(), kind: "chat" });
        void vscode.window.showInformationMessage(text);
      });
      this.relay.setTypingHandler((name) => {
        this.statusBar.text = `$(edit) ${name ?? "someone"} typing…`;
        setTimeout(() => this.refreshStatus(), 2000).unref?.();
      });
    }

    if (!this.relay.isRunning) {
      await this.relay.start();
    }

    this.mode = "sharing";
    const token = await this.relay.issueToken(this.sessionId, role);
    const joinHost = this.publicJoinHost(
      this.relay.getPort(),
      this.relay.getHost(),
      this.relay.isExternal()
    );
    const joinCommand = `/chorus-join token="${token.token}" host="${joinHost}"`;
    this.appendSystem(
      this.relay.isExternal()
        ? `Attached to external relay ${this.relay.getHost()}:${this.relay.getPort()}`
        : `chorus-relay started on port ${this.relay.getPort()}`
    );
    this.appendSystem(`Share ready (${role}). Collaborator command:\n${joinCommand}`);
    this.refreshStatus();

    await vscode.env.clipboard.writeText(joinCommand);
    void vscode.window.showInformationMessage(
      `Chorus sharing — join command copied to clipboard.`,
      "Copy again"
    ).then((choice) => {
      if (choice === "Copy again") void vscode.env.clipboard.writeText(joinCommand);
    });

    return joinCommand;
  }

  async join(token: string, host: string, name?: string): Promise<void> {
    if (this.mode === "sharing") {
      throw new Error("Stop sharing (Chorus: Stop Sharing) before joining another session.");
    }
    if (this.joinClient) {
      this.joinClient.disconnect();
      this.joinClient = null;
    }

    const displayName = name?.trim() || this.displayName();
    const jc = new JoinClient(`ws://${host}/ws`, token, displayName);
    await jc.connect();

    jc.setChatHandler((msgName, content) => {
      const text = `💬 [${msgName ?? "host"}]: ${content}`;
      this.append({ id: newEventId(), text, at: Date.now(), kind: "chat" });
      void vscode.window.showInformationMessage(text);
    });
    jc.setTypingHandler((typingName) => {
      this.statusBar.text = `$(edit) ${typingName ?? "someone"} typing…`;
      setTimeout(() => this.refreshStatus(), 2000).unref?.();
    });
    jc.setEventHandler((event) => this.appendSession(event));

    for (const event of jc.getState().recentEvents) {
      this.appendSession(event);
    }

    this.joinClient = jc;
    this.mode = "joined";
    this.appendSystem(`Joined ${host} as ${displayName}`);
    this.refreshStatus();
  }

  async leave(): Promise<void> {
    this.joinClient?.disconnect();
    this.joinClient = null;
    if (this.mode === "joined") this.mode = "idle";
    this.appendSystem("Left shared session");
    this.refreshStatus();
  }

  stop(): void {
    this.mode = "idle";
    this.relay?.stop();
    this.relay = null;
    this.appendSystem("Stopped sharing");
    this.refreshStatus();
  }

  sendChat(message: string): void {
    if (this.mode === "sharing" && this.relay) {
      this.relay.sendChat(this.displayName(), message);
      this.append({
        id: newEventId(),
        text: `💬 [${this.displayName()}]: ${message}`,
        at: Date.now(),
        kind: "chat",
      });
      return;
    }
    if (this.mode === "joined" && this.joinClient?.getState().status === "connected") {
      this.joinClient.sendTyping();
      this.joinClient.sendChat(message);
      this.append({
        id: newEventId(),
        text: `💬 [${this.displayName()}]: ${message}`,
        at: Date.now(),
        kind: "chat",
      });
      return;
    }
    throw new Error("Not currently sharing or joined.");
  }

  /** Joiner → host collab.input */
  sendPrompt(content: string): void {
    if (this.mode !== "joined" || !this.joinClient) {
      throw new Error("Join a session first to send prompts to the host.");
    }
    this.joinClient.sendInput(content);
    this.appendSystem(`→ sent prompt to host (${content.slice(0, 80)}${content.length > 80 ? "…" : ""})`);
  }

  /** Host publishes a user/assistant line onto the shared transcript. */
  publishHostMessage(content: string, type: "user" | "assistant" = "user"): void {
    if (this.mode !== "sharing" || !this.relay) {
      throw new Error("Share a session first to publish host messages.");
    }
    const event: SessionEvent = {
      id: newEventId(),
      sessionId: this.sessionId,
      type,
      payload: content,
      timestamp: Date.now(),
    };
    this.relay.pushEvent(event);
    this.appendSession(event);
  }

  statusText(): string {
    const share = this.getShareSummary();
    const join = this.joinClient
      ? { joined: true, ...this.joinClient.getState() }
      : { joined: false };
    return JSON.stringify({ mode: this.mode, ...share, ...join }, null, 2);
  }

  dispose(): void {
    this.joinClient?.disconnect();
    this.relay?.stop();
    this._onDidChange.dispose();
  }
}
