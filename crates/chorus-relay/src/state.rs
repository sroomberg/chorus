use crate::access::AccessManager;
use crate::protocol::{ChatMessage, ConnectedUser, RelayToHost, ServerMessage, SessionEvent};
use axum::extract::ws::Message;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub type ClientTx = mpsc::UnboundedSender<Message>;
pub type HostTx = mpsc::UnboundedSender<Message>;

pub struct RelayState {
    pub access: AccessManager,
    pub clients: HashMap<String, ClientTx>,
    pub host: Option<HostTx>,
    pub event_history: Vec<SessionEvent>,
    pub chat_history: Vec<ChatMessage>,
    pub port: u16,
    pub running: bool,
}

impl RelayState {
    pub fn new(port: u16) -> Self {
        Self {
            access: AccessManager::new(),
            clients: HashMap::new(),
            host: None,
            event_history: Vec::new(),
            chat_history: Vec::new(),
            port,
            running: true,
        }
    }

    pub fn broadcast_joiners(&self, msg: &ServerMessage) {
        if let Ok(encoded) = serde_json::to_string(msg) {
            let wire = Message::Text(encoded.into());
            for tx in self.clients.values() {
                let _ = tx.send(wire.clone());
            }
        }
    }

    pub fn send_joiner(&self, user_id: &str, msg: &ServerMessage) {
        if let (Some(tx), Ok(encoded)) = (self.clients.get(user_id), serde_json::to_string(msg)) {
            let _ = tx.send(Message::Text(encoded.into()));
        }
    }

    pub fn send_host(&self, msg: &RelayToHost) {
        if let (Some(tx), Ok(encoded)) = (&self.host, serde_json::to_string(msg)) {
            let _ = tx.send(Message::Text(encoded.into()));
        }
    }

    pub fn broadcast_except(&self, except_user_id: &str, msg: &ServerMessage) {
        if let Ok(encoded) = serde_json::to_string(msg) {
            let wire = Message::Text(encoded.into());
            for (uid, tx) in &self.clients {
                if uid != except_user_id {
                    let _ = tx.send(wire.clone());
                }
            }
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn list_users_except(&self, user_id: &str) -> Vec<ConnectedUser> {
        self.access
            .list_users()
            .into_iter()
            .filter(|u| u.user_id != user_id)
            .collect()
    }
}

pub type SharedState = Arc<RwLock<RelayState>>;
