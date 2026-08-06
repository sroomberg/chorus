use crate::protocol::{ConnectedUser, SessionToken, UserRole};
use rand::RngCore;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

pub fn generate_token(session_id: &str, role: UserRole, ttl_ms: Option<u64>) -> SessionToken {
    let created_at = now_ms();
    SessionToken {
        token: random_hex(32),
        session_id: session_id.to_string(),
        created_at,
        expires_at: ttl_ms.map(|ttl| created_at + ttl),
        granted_role: role,
    }
}

#[derive(Default)]
pub struct AccessManager {
    tokens: HashMap<String, SessionToken>,
    users: HashMap<String, ConnectedUser>,
}

impl AccessManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue_token(
        &mut self,
        session_id: &str,
        role: UserRole,
        ttl_ms: Option<u64>,
    ) -> SessionToken {
        let st = generate_token(session_id, role, ttl_ms);
        self.tokens.insert(st.token.clone(), st.clone());
        st
    }

    pub fn validate_token(&mut self, token: &str) -> Option<SessionToken> {
        let st = self.tokens.get(token)?.clone();
        if let Some(expires_at) = st.expires_at {
            if now_ms() > expires_at {
                self.tokens.remove(token);
                return None;
            }
        }
        Some(st)
    }

    pub fn revoke_token(&mut self, token: &str) {
        self.tokens.remove(token);
    }

    pub fn clear_tokens(&mut self) {
        self.tokens.clear();
    }

    pub fn add_user(
        &mut self,
        user_id: String,
        role: UserRole,
        display_name: Option<String>,
    ) -> ConnectedUser {
        let user = ConnectedUser {
            user_id: user_id.clone(),
            role,
            joined_at: now_ms(),
            display_name,
        };
        self.users.insert(user_id, user.clone());
        user
    }

    pub fn remove_user(&mut self, user_id: &str) {
        self.users.remove(user_id);
    }

    pub fn get_user(&self, user_id: &str) -> Option<&ConnectedUser> {
        self.users.get(user_id)
    }

    pub fn set_role(&mut self, user_id: &str, role: UserRole) -> bool {
        if let Some(user) = self.users.get_mut(user_id) {
            user.role = role;
            true
        } else {
            false
        }
    }

    pub fn list_users(&self) -> Vec<ConnectedUser> {
        self.users.values().cloned().collect()
    }

    pub fn is_admin(&self, user_id: &str) -> bool {
        matches!(
            self.users.get(user_id).map(|u| &u.role),
            Some(UserRole::Admin)
        )
    }

    pub fn can_send_input(&self, user_id: &str) -> bool {
        matches!(
            self.users.get(user_id).map(|u| &u.role),
            Some(UserRole::Admin) | Some(UserRole::Edit)
        )
    }

    pub fn new_user_id() -> String {
        random_hex(8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_token_is_64_hex() {
        let st = generate_token("sess-1", UserRole::Edit, None);
        assert_eq!(st.token.len(), 64);
        assert!(st.token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(st.expires_at.is_none());
    }

    #[test]
    fn generate_token_sets_expiry() {
        let before = now_ms();
        let st = generate_token("sess-1", UserRole::Edit, Some(5000));
        assert!(st.expires_at.unwrap() >= before + 4990);
    }

    #[test]
    fn issue_and_validate() {
        let mut mgr = AccessManager::new();
        let st = mgr.issue_token("sess-1", UserRole::Admin, None);
        let validated = mgr.validate_token(&st.token).unwrap();
        assert_eq!(validated.session_id, "sess-1");
        assert_eq!(validated.granted_role, UserRole::Admin);
    }

    #[test]
    fn unknown_token_is_none() {
        let mut mgr = AccessManager::new();
        assert!(mgr.validate_token("nope").is_none());
    }

    #[test]
    fn revoke_token() {
        let mut mgr = AccessManager::new();
        let st = mgr.issue_token("sess-1", UserRole::Edit, None);
        mgr.revoke_token(&st.token);
        assert!(mgr.validate_token(&st.token).is_none());
    }

    #[test]
    fn expired_token_rejected() {
        let mut mgr = AccessManager::new();
        let mut st = mgr.issue_token("sess-1", UserRole::Edit, None);
        st.expires_at = Some(1);
        mgr.tokens.insert(st.token.clone(), st.clone());
        assert!(mgr.validate_token(&st.token).is_none());
    }

    #[test]
    fn roles_and_input_permissions() {
        let mut mgr = AccessManager::new();
        let admin = mgr.add_user("a".into(), UserRole::Admin, Some("A".into()));
        let editor = mgr.add_user("e".into(), UserRole::Edit, None);
        let viewer = mgr.add_user("v".into(), UserRole::View, None);
        assert!(mgr.is_admin(&admin.user_id));
        assert!(mgr.can_send_input(&editor.user_id));
        assert!(!mgr.can_send_input(&viewer.user_id));
        assert!(mgr.set_role("v", UserRole::Edit));
        assert!(mgr.can_send_input("v"));
    }
}
