import { useState, useEffect, useRef } from "react";
import type { ChatMessage, ConnectedUser } from "@chorus/shared";

interface Props {
  messages: ChatMessage[];
  users: ConnectedUser[];
  myUserId: string | null;
  onSend: (content: string) => void;
  onPromote?: (userId: string) => void;
  onDemote?: (userId: string) => void;
  onKick?: (userId: string) => void;
  isHost: boolean;
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 280,
    minWidth: 220,
    display: "flex",
    flexDirection: "column",
    background: "#242424",
    borderLeft: "1px solid #333",
    height: "100%",
  },
  header: {
    padding: "10px 12px",
    borderBottom: "1px solid #333",
    fontSize: 13,
    fontWeight: 600,
    color: "#aaa",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  userList: {
    padding: "8px 0",
    borderBottom: "1px solid #333",
    maxHeight: 120,
    overflowY: "auto",
  },
  userRow: {
    display: "flex",
    alignItems: "center",
    padding: "3px 12px",
    fontSize: 13,
    gap: 6,
  },
  roleBadge: (role: string): React.CSSProperties => ({
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 3,
    background: role === "host" ? "#4a3a00" : role === "collaborator" ? "#003a4a" : "#2a2a2a",
    color: role === "host" ? "#ffd" : role === "collaborator" ? "#aef" : "#888",
  }),
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 0",
  },
  msg: {
    padding: "4px 12px",
    fontSize: 13,
    lineHeight: 1.5,
  },
  msgName: {
    fontWeight: 600,
    marginRight: 6,
    color: "#7af",
  },
  inputRow: {
    display: "flex",
    padding: 8,
    gap: 6,
    borderTop: "1px solid #333",
  },
  input: {
    flex: 1,
    background: "#1a1a1a",
    border: "1px solid #444",
    borderRadius: 4,
    padding: "5px 8px",
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
  },
  sendBtn: {
    background: "#2c6e49",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
};

export function ChatSidebar({
  messages,
  users,
  myUserId,
  onSend,
  onPromote,
  onDemote,
  onKick,
  isHost,
}: Props) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div style={styles.sidebar} data-testid="chat-sidebar">
      <div style={styles.header}>chorus</div>

      <div style={styles.userList}>
        {users.map((u) => (
          <div key={u.userId} style={styles.userRow}>
            <span>{u.displayName ?? u.userId.slice(0, 8)}</span>
            <span style={styles.roleBadge(u.role)}>{u.role}</span>
            {isHost && u.userId !== myUserId && (
              <>
                {u.role === "viewer" && (
                  <button
                    style={{ fontSize: 11, cursor: "pointer" }}
                    onClick={() => onPromote?.(u.userId)}
                  >
                    promote
                  </button>
                )}
                {u.role === "collaborator" && (
                  <button
                    style={{ fontSize: 11, cursor: "pointer" }}
                    onClick={() => onDemote?.(u.userId)}
                  >
                    demote
                  </button>
                )}
                <button
                  style={{ fontSize: 11, cursor: "pointer", color: "#f88" }}
                  onClick={() => onKick?.(u.userId)}
                >
                  kick
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div style={styles.messages}>
        {messages.map((m) => (
          <div key={m.id} style={styles.msg}>
            <span style={styles.msgName}>{m.displayName ?? m.userId.slice(0, 8)}</span>
            {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Chat..."
          data-testid="chat-input"
        />
        <button style={styles.sendBtn} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
