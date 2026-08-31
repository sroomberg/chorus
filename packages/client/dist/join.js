import { encodeMessage, decodeServerMessage, } from "@chorus/shared";
export class JoinClient {
    relayUrl;
    token;
    displayName;
    repoRemote;
    email;
    ws = null;
    state;
    onEvent;
    onChatMessage;
    onTyping;
    onPending;
    onApproved;
    constructor(relayUrl, token, displayName, repoRemote, email) {
        this.relayUrl = relayUrl;
        this.token = token;
        this.displayName = displayName;
        this.repoRemote = repoRemote;
        this.email = email;
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
            let settled = false;
            const succeed = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            const fail = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(err);
            };
            ws.onopen = () => {
                const auth = {
                    type: "auth",
                    token: this.token,
                    displayName: this.displayName,
                };
                if (this.repoRemote)
                    auth.repoRemote = this.repoRemote;
                if (this.email)
                    auth.email = this.email;
                ws.send(encodeMessage(auth));
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
                    case "auth.pending":
                        this.state.status = "pending";
                        this.state.userId = msg.userId;
                        this.onPending?.(msg.userId);
                        succeed();
                        break;
                    case "auth.denied":
                        this.state.status = "error";
                        this.state.error = msg.message;
                        fail(new Error(msg.message));
                        ws.close();
                        break;
                    case "session.history":
                        this.state.recentEvents = msg.events.slice(-50);
                        this.state.status = "connected";
                        this.onApproved?.();
                        succeed();
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
                    case "error": {
                        const wasAdmitted = this.state.status === "connected" || this.state.status === "pending";
                        this.state.status = "error";
                        this.state.error = msg.message;
                        if (!wasAdmitted) {
                            fail(new Error(msg.message));
                        }
                        break;
                    }
                }
            };
            ws.onerror = () => {
                this.state.status = "error";
                this.state.error = "Connection error";
                fail(new Error("WebSocket connection error"));
            };
            ws.onclose = () => {
                if (this.state.status === "connected" || this.state.status === "pending") {
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
    setPendingHandler(fn) {
        this.onPending = fn;
    }
    setApprovedHandler(fn) {
        this.onApproved = fn;
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
//# sourceMappingURL=join.js.map