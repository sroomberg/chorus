import type { SessionEvent, ChatMessage, ConnectedUser, UserRole } from "./types.js";
export type ServerMessage = {
    type: "session.event";
    event: SessionEvent;
} | {
    type: "session.history";
    events: SessionEvent[];
} | {
    type: "session.closed";
} | {
    type: "chat.message";
    message: ChatMessage;
} | {
    type: "user.joined";
    user: ConnectedUser;
} | {
    type: "user.left";
    userId: string;
} | {
    type: "user.role_changed";
    userId: string;
    role: UserRole;
} | {
    type: "user.list";
    users: ConnectedUser[];
} | {
    type: "user.typing";
    userId: string;
    displayName?: string;
} | {
    type: "error";
    code: string;
    message: string;
};
export type ClientMessage = {
    type: "auth";
    token: string;
    displayName?: string;
} | {
    type: "chat.send";
    content: string;
} | {
    type: "typing";
} | {
    type: "collab.input";
    content: string;
} | {
    type: "host.promote";
    userId: string;
} | {
    type: "host.demote";
    userId: string;
} | {
    type: "host.kick";
    userId: string;
} | {
    type: "host.close";
};
export declare function encodeMessage(msg: ServerMessage | ClientMessage): string;
export declare function decodeServerMessage(raw: string): ServerMessage;
export declare function decodeClientMessage(raw: string): ClientMessage;
//# sourceMappingURL=protocol.d.ts.map