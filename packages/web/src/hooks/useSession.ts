import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionEvent, ConnectedUser } from "@chorus/shared";
import {
  encodeMessage,
  decodeServerMessage,
  type ServerMessage,
} from "@chorus/shared";

export interface SessionState {
  connected: boolean;
  events: SessionEvent[];
  users: ConnectedUser[];
  myUserId: string | null;
  error: string | null;
}

export interface SessionActions {
  sendInput: (content: string) => void;
  promoteUser: (userId: string) => void;
  demoteUser: (userId: string) => void;
  kickUser: (userId: string) => void;
  closeSession: () => void;
}

export function useSession(
  wsUrl: string,
  token: string,
  displayName?: string
): [SessionState, SessionActions] {
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<SessionState>({
    connected: false,
    events: [],
    users: [],
    myUserId: null,
    error: null,
  });

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => {
      socket.send(encodeMessage({ type: "auth", token, displayName }));
    };

    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = decodeServerMessage(ev.data as string);
      } catch {
        return;
      }

      setState((prev) => {
        switch (msg.type) {
          case "session.history":
            return { ...prev, connected: true, events: msg.events };
          case "session.event":
            return { ...prev, events: [...prev.events, msg.event] };
          case "user.list":
            return { ...prev, users: msg.users };
          case "user.joined":
            return { ...prev, users: [...prev.users, msg.user] };
          case "user.left":
            return { ...prev, users: prev.users.filter((u) => u.userId !== msg.userId) };
          case "user.role_changed":
            return {
              ...prev,
              users: prev.users.map((u) =>
                u.userId === msg.userId ? { ...u, role: msg.role } : u
              ),
            };
          case "session.closed":
            return { ...prev, connected: false, error: "Session closed by host" };
          case "error":
            return { ...prev, error: msg.message };
          default:
            return prev;
        }
      });
    };

    socket.onclose = () => {
      setState((prev) => ({ ...prev, connected: false }));
    };

    socket.onerror = () => {
      setState((prev) => ({ ...prev, error: "Connection error", connected: false }));
    };

    return () => socket.close();
  }, [wsUrl, token, displayName]);

  const send = useCallback((msg: Parameters<typeof encodeMessage>[0]) => {
    ws.current?.send(encodeMessage(msg));
  }, []);

  const actions: SessionActions = {
    sendInput: (content) => send({ type: "collab.input", content }),
    promoteUser: (userId) => send({ type: "host.promote", userId }),
    demoteUser: (userId) => send({ type: "host.demote", userId }),
    kickUser: (userId) => send({ type: "host.kick", userId }),
    closeSession: () => send({ type: "host.close" }),
  };

  return [state, actions];
}
