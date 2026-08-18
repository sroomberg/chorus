use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    Edit,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserStatus {
    Pending,
    Active,
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
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub status: UserStatus,
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

/// Host/path substitution applied after a remote is reduced to `host/path`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoRemoteRewrite {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionPolicy {
    pub require_approval: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_email_domain: Option<String>,
    /// Extra URL prefixes stripped during remote normalization (e.g. `git://`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_repo_remote_prefixes: Vec<String>,
    /// Host substitutions after prefix stripping (e.g. github.acme.com → github.com).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repo_remote_rewrites: Vec<RepoRemoteRewrite>,
}

impl SessionPolicy {
    pub fn normalize_remote(&self, raw: &str) -> String {
        normalize_repo_remote_with(
            raw,
            &self.additional_repo_remote_prefixes,
            &self.repo_remote_rewrites,
        )
    }
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
    #[serde(rename = "auth.pending")]
    AuthPending {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "auth.denied")]
    AuthDenied { message: String },
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
        display_name: String,
        #[serde(rename = "repoRemote", default, skip_serializing_if = "Option::is_none")]
        repo_remote: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        email: Option<String>,
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
    #[serde(rename = "session.policy")]
    SessionPolicy {
        #[serde(rename = "requireApproval")]
        require_approval: Option<bool>,
        /// Empty string clears the repo gate; omit to leave unchanged.
        #[serde(rename = "repoRemote", default)]
        repo_remote: Option<String>,
        /// Empty string clears the email domain gate; omit to leave unchanged.
        #[serde(rename = "allowedEmailDomain", default, skip_serializing_if = "Option::is_none")]
        allowed_email_domain: Option<String>,
        /// Omit to leave unchanged; empty array clears extra prefixes.
        #[serde(rename = "additionalRepoRemotePrefixes", default, skip_serializing_if = "Option::is_none")]
        additional_repo_remote_prefixes: Option<Vec<String>>,
        /// Omit to leave unchanged; empty array clears rewrites.
        #[serde(rename = "repoRemoteRewrites", default, skip_serializing_if = "Option::is_none")]
        repo_remote_rewrites: Option<Vec<RepoRemoteRewrite>>,
    },
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
    #[serde(rename = "host.approve")]
    HostApprove {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "host.deny")]
    HostDeny {
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
    #[serde(rename = "user.pending")]
    UserPending { user: ConnectedUser },
    #[serde(rename = "user.left")]
    UserLeft {
        #[serde(rename = "userId")]
        user_id: String,
    },
    #[serde(rename = "user.list")]
    UserList { users: Vec<ConnectedUser> },
    #[serde(rename = "status")]
    Status {
        clients: usize,
        running: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        policy: Option<SessionPolicy>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

const BUILTIN_REPO_REMOTE_PREFIXES: &[&str] = &[
    "git+https://",
    "https://",
    "http://",
    "ssh://git@",
    "ssh://",
    "git@",
];
const MAX_REPO_REMOTE_PREFIXES: usize = 32;
const MAX_REPO_REMOTE_REWRITES: usize = 32;
const MAX_REPO_REMOTE_PREFIX_LEN: usize = 64;
const MAX_REPO_REMOTE_REWRITE_LEN: usize = 253;

/// Normalize git remotes so SSH/HTTPS clones of the same repo compare equal.
pub fn normalize_repo_remote(raw: &str) -> String {
    normalize_repo_remote_with(raw, &[], &[])
}

pub fn sanitize_repo_remote_prefixes(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for prefix in raw.iter().take(MAX_REPO_REMOTE_PREFIXES) {
        let prefix = prefix.trim().to_ascii_lowercase();
        if prefix.is_empty() || prefix.len() > MAX_REPO_REMOTE_PREFIX_LEN {
            continue;
        }
        if !out.iter().any(|existing| existing == &prefix) {
            out.push(prefix);
        }
    }
    out
}

pub fn sanitize_repo_remote_rewrites(raw: &[RepoRemoteRewrite]) -> Vec<RepoRemoteRewrite> {
    let mut out = Vec::new();
    for rule in raw.iter().take(MAX_REPO_REMOTE_REWRITES) {
        let from = rule.from.trim().trim_end_matches('/').to_ascii_lowercase();
        let to = rule.to.trim().trim_end_matches('/').to_ascii_lowercase();
        if from.is_empty()
            || to.is_empty()
            || from.len() > MAX_REPO_REMOTE_REWRITE_LEN
            || to.len() > MAX_REPO_REMOTE_REWRITE_LEN
        {
            continue;
        }
        out.push(RepoRemoteRewrite { from, to });
    }
    out
}

/// Same as [`normalize_repo_remote`], plus host-configured prefixes and rewrites.
pub fn normalize_repo_remote_with(
    raw: &str,
    extra_prefixes: &[String],
    rewrites: &[RepoRemoteRewrite],
) -> String {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return s;
    }
    if s.to_ascii_lowercase().ends_with(".git") {
        s.truncate(s.len() - 4);
    }

    if let Some(rest) = s.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            let path = path.trim_start_matches('/');
            let normalized = format!("{}/{}", host.to_ascii_lowercase(), path)
                .trim_end_matches('/')
                .to_string();
            return apply_repo_remote_rewrites(&normalized, rewrites);
        }
    }

    let lower = s.to_ascii_lowercase();
    s = strip_repo_remote_prefix(&lower, extra_prefixes);

    if let Some(at) = s.find('@') {
        if !s[..at].contains('/') {
            s = s[at + 1..].to_string();
        }
    }

    apply_repo_remote_rewrites(s.trim_end_matches('/'), rewrites)
}

fn strip_repo_remote_prefix(lower: &str, extra_prefixes: &[String]) -> String {
    let mut prefixes: Vec<&str> = extra_prefixes.iter().map(String::as_str).collect();
    prefixes.extend_from_slice(BUILTIN_REPO_REMOTE_PREFIXES);
    prefixes.sort_by(|a, b| b.len().cmp(&a.len()));
    for prefix in prefixes {
        if prefix.is_empty() {
            continue;
        }
        if let Some(rest) = lower.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    lower.to_string()
}

fn apply_repo_remote_rewrites(normalized: &str, rewrites: &[RepoRemoteRewrite]) -> String {
    let mut out = normalized.to_string();
    for rule in rewrites {
        let from = rule.from.trim().trim_end_matches('/').to_ascii_lowercase();
        let to = rule.to.trim().trim_end_matches('/').to_ascii_lowercase();
        if from.is_empty() {
            continue;
        }
        if let Some(rest) = out.strip_prefix(&from) {
            if rest.is_empty() || rest.starts_with('/') {
                out = format!("{to}{rest}");
            }
        }
    }
    out
}

pub fn normalize_display_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() {
        return None;
    }
    if name.len() > 64 {
        Some(name.chars().take(64).collect())
    } else {
        Some(name.to_string())
    }
}

pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_ascii_lowercase();
    if email.is_empty() {
        return None;
    }
    let at = email.find('@')?;
    if at == 0 || at == email.len() - 1 || email[at + 1..].contains('@') {
        return None;
    }
    if email.len() > 254 {
        Some(email.chars().take(254).collect())
    } else {
        Some(email)
    }
}

pub fn email_matches_domain(email: &str, allowed_domain: &str) -> bool {
    let domain = allowed_domain
        .trim()
        .trim_start_matches('@')
        .to_ascii_lowercase();
    if domain.is_empty() {
        return true;
    }
    let Some(at) = email.rfind('@') else {
        return false;
    };
    email[at + 1..].eq_ignore_ascii_case(&domain)
}

#[cfg(test)]
mod repo_tests {
    use super::{
        email_matches_domain, normalize_email, normalize_repo_remote, normalize_repo_remote_with,
        RepoRemoteRewrite,
    };

    #[test]
    fn normalizes_ssh_and_https() {
        assert_eq!(
            normalize_repo_remote("git@github.com:acme/app.git"),
            "github.com/acme/app"
        );
        assert_eq!(
            normalize_repo_remote("https://github.com/acme/app.git"),
            "github.com/acme/app"
        );
        assert_eq!(
            normalize_repo_remote("ssh://git@gitlab.com/acme/app"),
            "gitlab.com/acme/app"
        );
    }

    #[test]
    fn normalizes_and_matches_email_domain() {
        assert_eq!(
            normalize_email("  Alice@Acme.COM  ").as_deref(),
            Some("alice@acme.com")
        );
        assert!(normalize_email("not-an-email").is_none());
        assert!(email_matches_domain("alice@acme.com", "acme.com"));
        assert!(email_matches_domain("alice@acme.com", "@acme.com"));
        assert!(!email_matches_domain("alice@other.com", "acme.com"));
    }

    #[test]
    fn extra_prefix_and_rewrite_normalize_custom_remotes() {
        let prefixes = vec!["git://".to_string()];
        assert_eq!(
            normalize_repo_remote_with("git://github.com/acme/app.git", &prefixes, &[]),
            "github.com/acme/app"
        );
        let rewrites = vec![RepoRemoteRewrite {
            from: "github.acme.com".into(),
            to: "github.com".into(),
        }];
        assert_eq!(
            normalize_repo_remote_with("https://github.acme.com/acme/app.git", &[], &rewrites),
            "github.com/acme/app"
        );
        assert_eq!(
            normalize_repo_remote("https://github.com/acme/app.git"),
            "github.com/acme/app"
        );
    }
}
