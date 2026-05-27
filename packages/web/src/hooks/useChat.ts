import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatMessage } from "@chorus/shared";
import { encodeMessage, decodeServerMessage } from "@chorus/shared";

export function useChat(
  wsUrl: string,
  token: string,
  displayName?: string
): {
  messages: ChatMessage[];
  sendMessage: (content: string) => void;
} {
  const ws = useRef<WebSocket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => {
      socket.send(encodeMessage({ type: "auth", token, displayName }));
    };

    socket.onmessage = (ev) => {
      try {
        const msg = decodeServerMessage(ev.data as string);
        if (msg.type === "chat.message") {
          setMessages((prev) => [...prev, msg.message]);
        }
      } catch {
        // ignore malformed frames
      }
    };

    return () => socket.close();
  }, [wsUrl, token, displayName]);

  const sendMessage = useCallback((content: string) => {
    ws.current?.send(encodeMessage({ type: "chat.send", content }));
  }, []);

  return { messages, sendMessage };
}
