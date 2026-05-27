import type { SessionEvent, ChatMessage, ConnectedUser, UserRole } from "./types.js";

// Messages sent from server (plugin relay) to client (browser)
export type ServerMessage =
  | { type: "session.event"; event: SessionEvent }
  | { type: "session.history"; events: SessionEvent[] }
  | { type: "session.closed" }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "user.joined"; user: ConnectedUser }
  | { type: "user.left"; userId: string }
  | { type: "user.role_changed"; userId: string; role: UserRole }
  | { type: "user.list"; users: ConnectedUser[] }
  | { type: "error"; code: string; message: string };

// Messages sent from client (browser) to server (plugin relay)
export type ClientMessage =
  | { type: "auth"; token: string; displayName?: string }
  | { type: "chat.send"; content: string }
  | { type: "collab.input"; content: string }
  | { type: "host.promote"; userId: string }
  | { type: "host.demote"; userId: string }
  | { type: "host.kick"; userId: string }
  | { type: "host.close" };

export function encodeMessage(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeServerMessage(raw: string): ServerMessage {
  const parsed = JSON.parse(raw) as ServerMessage;
  return parsed;
}

export function decodeClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as ClientMessage;
  return parsed;
}
