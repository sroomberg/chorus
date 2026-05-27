import { useState } from "react";

interface Props {
  onJoin: (displayName: string) => void;
}

export function JoinScreen({ onJoin }: Props) {
  const [name, setName] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onJoin(trimmed);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        background: "#1a1a1a",
      }}
    >
      <div
        style={{
          background: "#242424",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "32px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minWidth: 320,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700, color: "#e0e0e0" }}>
          Join session
        </div>
        <div style={{ fontSize: 13, color: "#888" }}>
          Enter a display name to identify yourself in the session.
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Your name"
          data-testid="join-name-input"
          style={{
            background: "#1a1a1a",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "8px 12px",
            color: "#e0e0e0",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={!name.trim()}
          data-testid="join-submit"
          style={{
            background: name.trim() ? "#2c6e49" : "#2a2a2a",
            color: name.trim() ? "#fff" : "#666",
            border: "none",
            borderRadius: 4,
            padding: "9px 0",
            cursor: name.trim() ? "pointer" : "default",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Join
        </button>
      </div>
    </div>
  );
}
