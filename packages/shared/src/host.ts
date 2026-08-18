import type {
  SessionEvent,
  ChatMessage,
  ConnectedUser,
  SessionToken,
  UserRole,
  SessionPolicy,
} from "./types.js";

/** Control-plane messages: OpenCode plugin host → Rust relay (`/host`). */
export type HostToRelay =
  | { type: "host.auth"; token: string }
  | { type: "token.issue"; sessionId: string; role?: UserRole; ttlMs?: number }
  | { type: "session.event"; event: SessionEvent }
  | {
      type: "session.policy";
      requireApproval?: boolean;
      repoRemote?: string | null;
      allowedEmailDomain?: string | null;
      additionalRepoRemotePrefixes?: string[] | null;
      repoRemoteRewrites?: { from: string; to: string }[] | null;
    }
  | { type: "chat.send"; content: string; displayName?: string }
  | { type: "host.promote"; userId: string }
  | { type: "host.demote"; userId: string }
  | { type: "host.kick"; userId: string }
  | { type: "host.approve"; userId: string }
  | { type: "host.deny"; userId: string }
  | { type: "host.close" }
  | { type: "status.get" };

/** Control-plane messages: Rust relay → OpenCode plugin host (`/host`). */
export type RelayToHost =
  | { type: "host.ready"; port: number }
  | (SessionToken & { type: "token.issued" })
  | {
      type: "collab.input";
      userId: string;
      displayName?: string;
      content: string;
    }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "user.typing"; userId: string; displayName?: string }
  | { type: "user.joined"; user: ConnectedUser }
  | { type: "user.pending"; user: ConnectedUser }
  | { type: "user.left"; userId: string }
  | { type: "user.list"; users: ConnectedUser[] }
  | { type: "status"; clients: number; running: boolean; policy?: SessionPolicy }
  | { type: "error"; code: string; message: string };

export function encodeHostMessage(msg: HostToRelay): string {
  return JSON.stringify(msg);
}

export function decodeRelayToHost(raw: string): RelayToHost {
  return JSON.parse(raw) as RelayToHost;
}
