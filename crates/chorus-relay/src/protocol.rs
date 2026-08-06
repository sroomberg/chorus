use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    Edit,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionToken {
    pub token: String,
    pub session_id: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub granted_role: UserRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedUser {
    pub user_id: String,
    pub role: UserRole,
    pub joined_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub content: String,
    pub timestamp: u64,
}

/// Messages sent from the relay to joiner clients on `/ws`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "session.event")]
    SessionEvent { event: SessionEvent },
    #[serde(rename = "session.history")]
    SessionHistory { events: Vec<SessionEvent> },
    #[serde(rename = "session.closed")]
    SessionClosed,
    #[serde(rename = "chat.message")]
    ChatMessage { message: ChatMessage },
    #[serde(rename = "user.joined")]
    UserJoined { user: ConnectedUser },
    #[serde(rename = "user.left")]
    UserLeft {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "user.role_changed")]
    UserRoleChanged {
        #[serde(rename = "userId")]
        user_id: String,
        role: UserRole,
    },
    #[serde(rename = "user.list")]
    UserList { users: Vec<ConnectedUser> },
    #[serde(rename = "user.typing")]
    UserTyping {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

/// Messages sent from joiner clients to the relay on `/ws`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "auth")]
    Auth {
        token: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
    },
    #[serde(rename = "chat.send")]
    ChatSend { content: String },
    #[serde(rename = "typing")]
    Typing,
    #[serde(rename = "collab.input")]
    CollabInput { content: String },
    #[serde(rename = "host.promote")]
    HostPromote {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.demote")]
    HostDemote {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.kick")]
    HostKick {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.close")]
    HostClose,
}

/// Control-plane messages from the OpenCode plugin host → relay (`/host`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HostToRelay {
    #[serde(rename = "host.auth")]
    HostAuth { token: String },
    #[serde(rename = "token.issue")]
    TokenIssue {
        #[serde(rename = "sessionId")]
        session_id: String,
        role: Option<UserRole>,
        #[serde(rename = "ttlMs")]
        ttl_ms: Option<u64>,
    },
    #[serde(rename = "session.event")]
    SessionEvent { event: SessionEvent },
    #[serde(rename = "chat.send")]
    ChatSend {
        content: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
    },
    #[serde(rename = "host.promote")]
    HostPromote {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.demote")]
    HostDemote {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.kick")]
    HostKick {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.close")]
    HostClose,
    #[serde(rename = "status.get")]
    StatusGet,
}

/// Control-plane messages from the relay → OpenCode plugin host (`/host`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayToHost {
    #[serde(rename = "host.ready")]
    HostReady { port: u16 },
    #[serde(rename = "token.issued")]
    TokenIssued {
        #[serde(flatten)]
        token: SessionToken,
    },
    #[serde(rename = "collab.input")]
    CollabInput {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
        content: String,
    },
    #[serde(rename = "chat.message")]
    ChatMessage { message: ChatMessage },
    #[serde(rename = "user.typing")]
    UserTyping {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
    },
    #[serde(rename = "user.joined")]
    UserJoined { user: ConnectedUser },
    #[serde(rename = "user.left")]
    UserLeft {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "user.list")]
    UserList { users: Vec<ConnectedUser> },
    #[serde(rename = "status")]
    Status { clients: usize, running: bool },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}
