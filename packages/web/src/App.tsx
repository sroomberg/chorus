import { useMemo, useState } from "react";
import { useSession } from "./hooks/useSession.js";
import { useChat } from "./hooks/useChat.js";
import { TerminalPane } from "./components/TerminalPane/index.js";
import { ChatSidebar } from "./components/ChatSidebar/index.js";
import { Controls } from "./components/Controls/index.js";

function getParams(): { wsUrl: string; token: string; displayName?: string } {
  const sp = new URLSearchParams(window.location.search);
  const token = sp.get("token") ?? "";
  const displayName = sp.get("name") ?? undefined;
  const host = sp.get("host") ?? window.location.host;
  const wsUrl = `ws://${host}/ws`;
  return { wsUrl, token, displayName };
}

export function App() {
  const { wsUrl, token, displayName } = useMemo(getParams, []);
  const [session, actions] = useSession(wsUrl, token, displayName);
  const chat = useChat(wsUrl, token, displayName);
  const [inputMode, setInputMode] = useState(false);

  const myUser = session.users.find((u) => u.userId === session.myUserId);
  const isHost = myUser?.role === "host";
  const canInput = myUser?.role === "host" || myUser?.role === "collaborator";

  if (!token) {
    return (
      <div style={{ padding: 40, color: "#f88" }}>
        No session token provided. Open the URL shared by the session host.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Controls isHost={isHost} onCloseSession={actions.closeSession} />
      {session.error && (
        <div style={{ padding: "6px 12px", background: "#3a1a1a", color: "#f88", fontSize: 13 }}>
          {session.error}
        </div>
      )}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {canInput && (
            <div style={{ padding: "4px 8px", background: "#1e1e1e", borderBottom: "1px solid #333", fontSize: 12 }}>
              <label style={{ cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={inputMode}
                  onChange={(e) => setInputMode(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Send input to LLM
              </label>
            </div>
          )}
          <TerminalPane
            events={session.events}
            canInput={canInput && inputMode}
            onInput={actions.sendInput}
          />
        </div>
        <ChatSidebar
          messages={chat.messages}
          users={session.users}
          myUserId={session.myUserId}
          onSend={chat.sendMessage}
          onPromote={actions.promoteUser}
          onDemote={actions.demoteUser}
          onKick={actions.kickUser}
          isHost={isHost}
        />
      </div>
    </div>
  );
}
