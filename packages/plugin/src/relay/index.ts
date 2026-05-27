import type { SessionEvent, ChatMessage } from "@chorus/shared";
import {
  encodeMessage,
  decodeClientMessage,
  type ServerMessage,
  type ClientMessage,
} from "@chorus/shared";
import type { AccessManager } from "../access/index.js";
import { randomBytes } from "node:crypto";

interface Client {
  userId: string;
  ws: WebSocket;
}

export class RelayServer {
  private clients = new Map<string, Client>();
  private eventHistory: SessionEvent[] = [];
  private chatHistory: ChatMessage[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private inputQueue: Array<{ userId: string; content: string }> = [];
  private onInjectInput?: (content: string, userId: string) => Promise<void>;

  constructor(
    private readonly access: AccessManager,
    private readonly port: number
  ) {}

  setInputHandler(fn: (content: string, userId: string) => Promise<void>): void {
    this.onInjectInput = fn;
  }

  start(): void {
    const relay = this;

    this.server = Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",

      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req, { data: {} });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/status") {
          return new Response(
            JSON.stringify({ status: "ok", clients: relay.clientCount }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("chorus relay — OpenCode only", { status: 200 });
      },

      websocket: {
        open(ws) {
          // Unauthenticated until auth message received
          ws.data = { userId: null };
        },

        message(ws, raw) {
          let msg: ClientMessage;
          try {
            msg = decodeClientMessage(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
          } catch {
            ws.send(
              encodeMessage({ type: "error", code: "BAD_MESSAGE", message: "Invalid JSON" })
            );
            return;
          }

          if (msg.type === "auth") {
            const st = relay.access.validateToken(msg.token);
            if (!st) {
              ws.send(
                encodeMessage({
                  type: "error",
                  code: "AUTH_FAILED",
                  message: "Invalid or expired token",
                })
              );
              ws.close(4001, "auth failed");
              return;
            }

            const userId = randomBytes(8).toString("hex");
            const user = relay.access.addUser(userId, st.grantedRole, msg.displayName);
            (ws.data as Record<string, unknown>)["userId"] = userId;

            relay.clients.set(userId, { userId, ws: ws as unknown as WebSocket });

            // Send history and existing users (excluding self) to the new joiner.
            // The subsequent user.joined broadcast adds the joiner to everyone's list.
            ws.send(
              encodeMessage({
                type: "session.history",
                events: relay.eventHistory,
              })
            );
            ws.send(
              encodeMessage({
                type: "user.list",
                users: relay.access.listUsers().filter((u) => u.userId !== userId),
              })
            );

            // Notify everyone (including the joiner) of the new user
            relay.broadcast({ type: "user.joined", user });
            return;
          }

          const userId = (ws.data as Record<string, unknown>)["userId"] as string | undefined;
          if (!userId) {
            ws.send(
              encodeMessage({ type: "error", code: "NOT_AUTHED", message: "Send auth first" })
            );
            return;
          }

          relay.handleClientMessage(userId, msg, ws as unknown as WebSocket);
        },

        close(ws) {
          const userId = (ws.data as Record<string, unknown>)["userId"] as string | undefined;
          if (userId) {
            relay.access.removeUser(userId);
            relay.clients.delete(userId);
            relay.broadcast({ type: "user.left", userId });
          }
        },
      },
    });
  }

  private handleClientMessage(userId: string, msg: ClientMessage, ws: WebSocket): void {
    switch (msg.type) {
      case "chat.send": {
        const user = this.access.getUser(userId);
        const chatMsg: ChatMessage = {
          id: randomBytes(8).toString("hex"),
          sessionId: "",
          userId,
          displayName: user?.displayName,
          content: msg.content,
          timestamp: Date.now(),
        };
        this.chatHistory.push(chatMsg);
        this.broadcast({ type: "chat.message", message: chatMsg });
        break;
      }

      case "collab.input": {
        if (!this.access.canSendInput(userId)) {
          (ws as unknown as { send: (s: string) => void }).send(
            encodeMessage({
              type: "error",
              code: "FORBIDDEN",
              message: "Viewer cannot send LLM input",
            })
          );
          return;
        }
        this.inputQueue.push({ userId, content: msg.content });
        this.flushInputQueue();
        break;
      }

      case "host.promote": {
        if (!this.access.isAdmin(userId)) return;
        if (this.access.setRole(msg.userId, "edit")) {
          this.broadcast({ type: "user.role_changed", userId: msg.userId, role: "edit" });
        }
        break;
      }

      case "host.demote": {
        if (!this.access.isAdmin(userId)) return;
        if (this.access.setRole(msg.userId, "view")) {
          this.broadcast({ type: "user.role_changed", userId: msg.userId, role: "view" });
        }
        break;
      }

      case "host.kick": {
        if (!this.access.isAdmin(userId)) return;
        const target = this.clients.get(msg.userId);
        if (target) {
          (target.ws as unknown as { close: (code: number, reason: string) => void }).close(
            4003,
            "kicked by host"
          );
        }
        break;
      }

      case "host.close": {
        if (!this.access.isAdmin(userId)) return;
        this.broadcast({ type: "session.closed" });
        this.stop();
        break;
      }
    }
  }

  private flushInputQueue(): void {
    if (!this.onInjectInput) return;
    const next = this.inputQueue.shift();
    if (!next) return;
    this.onInjectInput(next.content, next.userId).catch(console.error);
  }

  broadcast(msg: ServerMessage): void {
    const encoded = encodeMessage(msg);
    for (const client of this.clients.values()) {
      (client.ws as unknown as { send: (s: string) => void }).send(encoded);
    }
  }

  pushEvent(event: SessionEvent): void {
    this.eventHistory.push(event);
    this.broadcast({ type: "session.event", event });
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getPort(): number {
    return this.port;
  }
}
