import { encodeMessage, decodeServerMessage, } from "@chorus/shared";
export class JoinClient {
    relayUrl;
    token;
    displayName;
    ws = null;
    state;
    onEvent;
    onChatMessage;
    onTyping;
    constructor(relayUrl, token, displayName) {
        this.relayUrl = relayUrl;
        this.token = token;
        this.displayName = displayName;
        this.state = {
            status: "connecting",
            sessionId: "",
            users: [],
            recentEvents: [],
        };
    }
    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.relayUrl);
            this.ws = ws;
            ws.onopen = () => {
                ws.send(encodeMessage({ type: "auth", token: this.token, displayName: this.displayName }));
            };
            ws.onmessage = (ev) => {
                let msg;
                try {
                    msg = decodeServerMessage(ev.data);
                }
                catch {
                    return;
                }
                switch (msg.type) {
                    case "session.history":
                        this.state.recentEvents = msg.events.slice(-50);
                        this.state.status = "connected";
                        resolve();
                        break;
                    case "session.event":
                        this.state.recentEvents = [...this.state.recentEvents.slice(-49), msg.event];
                        this.onEvent?.(msg.event);
                        break;
                    case "user.list":
                        this.state.users = msg.users;
                        break;
                    case "user.joined":
                        this.state.users = [...this.state.users, msg.user];
                        break;
                    case "user.left":
                        this.state.users = this.state.users.filter((u) => u.userId !== msg.userId);
                        break;
                    case "user.role_changed":
                        this.state.users = this.state.users.map((u) => u.userId === msg.userId ? { ...u, role: msg.role } : u);
                        break;
                    case "chat.message":
                        this.onChatMessage?.(msg.message.displayName, msg.message.content);
                        break;
                    case "user.typing":
                        this.onTyping?.(msg.displayName);
                        break;
                    case "session.closed":
                        this.state.status = "disconnected";
                        ws.close();
                        break;
                    case "error":
                        this.state.status = "error";
                        this.state.error = msg.message;
                        if (this.state.recentEvents.length === 0) {
                            // Failed before we ever got history — reject the connect promise
                            reject(new Error(msg.message));
                        }
                        break;
                }
            };
            ws.onerror = () => {
                this.state.status = "error";
                this.state.error = "Connection error";
                reject(new Error("WebSocket connection error"));
            };
            ws.onclose = () => {
                if (this.state.status === "connected") {
                    this.state.status = "disconnected";
                }
            };
        });
    }
    sendInput(content) {
        if (!this.ws || this.state.status !== "connected")
            return;
        this.ws.send(encodeMessage({ type: "collab.input", content }));
    }
    sendChat(content) {
        if (!this.ws || this.state.status !== "connected")
            return;
        this.ws.send(encodeMessage({ type: "chat.send", content }));
    }
    setChatHandler(fn) {
        this.onChatMessage = fn;
    }
    setTypingHandler(fn) {
        this.onTyping = fn;
    }
    setEventHandler(fn) {
        this.onEvent = fn;
    }
    sendTyping() {
        if (!this.ws || this.state.status !== "connected")
            return;
        this.ws.send(encodeMessage({ type: "typing" }));
    }
    getState() {
        return this.state;
    }
    disconnect() {
        this.ws?.close();
        this.ws = null;
        this.state.status = "disconnected";
    }
}
//# sourceMappingURL=index.js.map