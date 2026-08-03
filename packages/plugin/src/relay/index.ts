import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { SessionEvent, SessionToken, UserRole } from "@chorus/shared";
import {
  encodeHostMessage,
  decodeRelayToHost,
  type HostToRelay,
  type RelayToHost,
} from "@chorus/shared";

function resolveRelayBin(): string {
  if (process.env["CHORUS_RELAY_BIN"]) return process.env["CHORUS_RELAY_BIN"];

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../target/release/chorus-relay"),
    join(here, "../../../../target/debug/chorus-relay"),
    join(here, "../../../../../target/release/chorus-relay"),
    join(here, "../../../../../target/debug/chorus-relay"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return "chorus-relay";
}

/**
 * Manages the Rust `chorus-relay` subprocess and the host control WebSocket.
 * Joiner-facing protocol on `/ws` is unchanged; the plugin talks to `/host`.
 */
export class RelayServer {
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private hostToken = "";
  private running = false;
  private clients = 0;
  private pendingToken: {
    resolve: (t: SessionToken) => void;
    reject: (e: Error) => void;
  } | null = null;

  private onInjectInput?: (content: string, userId: string, displayName?: string) => Promise<void>;
  private onChatMessage?: (displayName: string | undefined, content: string) => void;
  private onTyping?: (displayName: string | undefined) => void;

  constructor(private readonly port: number) {}

  setInputHandler(
    fn: (content: string, userId: string, displayName?: string) => Promise<void>
  ): void {
    this.onInjectInput = fn;
  }

  setChatHandler(fn: (displayName: string | undefined, content: string) => void): void {
    this.onChatMessage = fn;
  }

  setTypingHandler(fn: (displayName: string | undefined) => void): void {
    this.onTyping = fn;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.hostToken = randomBytes(32).toString("hex");
    const bin = resolveRelayBin();

    this.child = spawn(
      bin,
      ["--port", String(this.port), "--bind", "0.0.0.0", "--host-token", this.hostToken],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env },
      }
    );

    this.child.on("exit", () => {
      this.running = false;
      this.ws = null;
    });

    await this.waitForPort();
    await this.connectHost();
    this.running = true;
  }

  private async waitForPort(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/status`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(
      `chorus-relay did not become ready on port ${this.port}. ` +
        `Is the binary available? (CHORUS_RELAY_BIN or cargo build -p chorus-relay --release)`
    );
  }

  private connectHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/host`);
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error("host control connect timeout")), 5000);

      ws.onopen = () => {
        this.send({ type: "host.auth", token: this.hostToken });
      };

      ws.onmessage = (ev) => {
        let msg: RelayToHost;
        try {
          msg = decodeRelayToHost(String(ev.data));
        } catch {
          return;
        }
        this.handleHostMessage(msg, () => {
          clearTimeout(timer);
          resolve();
        });
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("host control WebSocket error"));
      };

      ws.onclose = () => {
        this.ws = null;
        this.running = false;
      };
    });
  }

  private handleHostMessage(msg: RelayToHost, onReady?: () => void): void {
    switch (msg.type) {
      case "host.ready":
        onReady?.();
        break;

      case "token.issued": {
        const { type: _t, ...token } = msg;
        this.pendingToken?.resolve(token);
        this.pendingToken = null;
        break;
      }

      case "collab.input":
        this.onInjectInput?.(msg.content, msg.userId, msg.displayName)?.catch(console.error);
        break;

      case "chat.message":
        this.onChatMessage?.(msg.message.displayName, msg.message.content);
        break;

      case "user.typing":
        this.onTyping?.(msg.displayName);
        break;

      case "user.joined":
        this.clients += 1;
        break;

      case "user.left":
        this.clients = Math.max(0, this.clients - 1);
        break;

      case "user.list":
        this.clients = msg.users.length;
        break;

      case "status":
        this.clients = msg.clients;
        break;

      case "error":
        this.pendingToken?.reject(new Error(msg.message));
        this.pendingToken = null;
        break;
    }
  }

  private send(msg: HostToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeHostMessage(msg));
  }

  issueToken(sessionId: string, role: UserRole = "edit", ttlMs?: number): Promise<SessionToken> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("relay host control not connected"));
        return;
      }
      this.pendingToken = { resolve, reject };
      this.send({ type: "token.issue", sessionId, role, ttlMs });
      setTimeout(() => {
        if (this.pendingToken) {
          this.pendingToken.reject(new Error("token.issue timed out"));
          this.pendingToken = null;
        }
      }, 5000);
    });
  }

  pushEvent(event: SessionEvent): void {
    this.send({ type: "session.event", event });
  }

  sendChat(displayName: string | undefined, content: string): void {
    this.send({ type: "chat.send", content, displayName });
  }

  stop(): void {
    this.send({ type: "host.close" });
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      // Escalate if it hangs
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill("SIGKILL");
      }, 1000).unref?.();
    }
    this.child = null;
    this.running = false;
    this.clients = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get clientCount(): number {
    return this.clients;
  }

  getPort(): number {
    return this.port;
  }
}
