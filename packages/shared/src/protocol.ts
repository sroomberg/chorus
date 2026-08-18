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
  | { type: "user.typing"; userId: string; displayName?: string }
  | { type: "auth.pending"; userId: string; message?: string }
  | { type: "auth.denied"; message: string }
  | { type: "error"; code: string; message: string };

// Messages sent from client (browser) to server (plugin relay)
export type ClientMessage =
  | { type: "auth"; token: string; displayName: string; repoRemote?: string; email?: string }
  | { type: "chat.send"; content: string }
  | { type: "typing" }
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

/** Non-empty trimmed display name, or null if invalid. */
export function normalizeDisplayName(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const name = raw.trim();
  if (!name) return null;
  if (name.length > 64) return name.slice(0, 64);
  return name;
}

/** Trimmed lowercase email, or null if invalid. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@", at + 1) !== -1) return null;
  if (email.length > 254) return email.slice(0, 254);
  return email;
}

export function emailMatchesDomain(email: string, allowedDomain: string): boolean {
  const domain = allowedDomain.trim().replace(/^@/, "").toLowerCase();
  if (!domain) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return email.slice(at + 1).toLowerCase() === domain;
}
