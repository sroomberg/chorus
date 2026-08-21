//! TCP peer network policy: allow/deny CIDRs and optional source-port allowlist.
//!
//! Evaluation order for each peer `SocketAddr`:
//! 1. If peer IP matches any **deny** CIDR → reject
//! 2. If **allow** CIDRs are non-empty → peer must match one (loopback may bypass)
//! 3. If **allowed ports** are non-empty → peer **source port** must be listed
//! 4. Otherwise admit
//!
//! Empty allow + empty deny + empty ports = unrestricted (LAN-friendly default).
//! Source-port allowlisting is intended for single-machine e2e (all peers are
//! 127.0.0.1) and for tight lockdowns that pin known client ports.

use ipnet::IpNet;
use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct NetworkPolicy {
    allow: Vec<IpNet>,
    deny: Vec<IpNet>,
    /// When non-empty, peer source port must be in this set.
    allowed_ports: BTreeSet<u16>,
    allow_loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkPolicyError {
    InvalidCidr(String),
    InvalidPort(String),
}

impl std::fmt::Display for NetworkPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetworkPolicyError::InvalidCidr(s) => write!(f, "invalid CIDR: {s}"),
            NetworkPolicyError::InvalidPort(s) => write!(f, "invalid port: {s}"),
        }
    }
}

impl std::error::Error for NetworkPolicyError {}

#[derive(Debug, Clone, Default)]
pub struct NetworkPolicyConfig {
    pub allowed_cidrs: Vec<String>,
    pub denied_cidrs: Vec<String>,
    pub allowed_ports: Vec<u16>,
    pub allow_loopback: bool,
}

impl NetworkPolicy {
    pub fn parse(config: NetworkPolicyConfig) -> Result<Self, NetworkPolicyError> {
        Ok(Self {
            allow: parse_cidrs(&config.allowed_cidrs)?,
            deny: parse_cidrs(&config.denied_cidrs)?,
            allowed_ports: config.allowed_ports.into_iter().collect(),
            allow_loopback: config.allow_loopback,
        })
    }

    pub fn is_restricted(&self) -> bool {
        !self.allow.is_empty() || !self.deny.is_empty() || !self.allowed_ports.is_empty()
    }

    pub fn allowed_cidrs(&self) -> impl Iterator<Item = String> + '_ {
        self.allow.iter().map(|n| n.to_string())
    }

    pub fn denied_cidrs(&self) -> impl Iterator<Item = String> + '_ {
        self.deny.iter().map(|n| n.to_string())
    }

    pub fn allowed_ports(&self) -> impl Iterator<Item = u16> + '_ {
        self.allowed_ports.iter().copied()
    }

    pub fn allows_socket(&self, addr: SocketAddr) -> bool {
        let ip = normalize_mapped_v4(addr.ip());

        if self.deny.iter().any(|net| net.contains(&ip)) {
            return false;
        }

        if !self.allow.is_empty() {
            let ip_ok = self.allow.iter().any(|net| net.contains(&ip))
                || (self.allow_loopback && is_loopback(ip));
            if !ip_ok {
                return false;
            }
        }

        if !self.allowed_ports.is_empty() && !self.allowed_ports.contains(&addr.port()) {
            return false;
        }

        true
    }
}

fn parse_cidrs(cidrs: &[String]) -> Result<Vec<IpNet>, NetworkPolicyError> {
    let mut nets = Vec::with_capacity(cidrs.len());
    for raw in cidrs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let net = parse_cidr_or_ip(trimmed)
            .map_err(|_| NetworkPolicyError::InvalidCidr(trimmed.to_string()))?;
        nets.push(net);
    }
    Ok(nets)
}

fn parse_cidr_or_ip(s: &str) -> Result<IpNet, String> {
    if let Ok(net) = IpNet::from_str(s) {
        return Ok(net);
    }
    let ip = IpAddr::from_str(s).map_err(|e| e.to_string())?;
    Ok(IpNet::from(ip))
}

fn is_loopback(addr: IpAddr) -> bool {
    match normalize_mapped_v4(addr) {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn normalize_mapped_v4(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    }
}

/// True when the bind address is the unspecified / "open" address.
pub fn is_open_bind(bind: &str) -> bool {
    let host = bind.split('%').next().unwrap_or(bind).trim();
    matches!(host, "0.0.0.0" | "::" | "[::]")
}

/// Back-compat alias used by older call sites / docs.
pub type NetworkAllowlist = NetworkPolicy;
pub type AllowlistError = NetworkPolicyError;

impl NetworkPolicy {
    /// Parse allow-CIDR-only policy (tests / simple callers).
    pub fn parse_allow(cidrs: &[String], allow_loopback: bool) -> Result<Self, NetworkPolicyError> {
        Self::parse(NetworkPolicyConfig {
            allowed_cidrs: cidrs.to_vec(),
            denied_cidrs: Vec::new(),
            allowed_ports: Vec::new(),
            allow_loopback,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4};

    fn sock(ip: [u8; 4], port: u16) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]), port))
    }

    #[test]
    fn empty_policy_admits_everyone() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allow_loopback: true,
            ..Default::default()
        })
        .unwrap();
        assert!(!p.is_restricted());
        assert!(p.allows_socket(sock([8, 8, 8, 8], 12345)));
    }

    #[test]
    fn cidr_allow_match_and_miss() {
        let p = NetworkPolicy::parse_allow(
            &["10.0.0.0/8".into(), "192.168.1.0/24".into()],
            false,
        )
        .unwrap();
        assert!(p.allows_socket(sock([10, 1, 2, 3], 1)));
        assert!(p.allows_socket(sock([192, 168, 1, 50], 1)));
        assert!(!p.allows_socket(sock([192, 168, 2, 1], 1)));
        assert!(!p.allows_socket(sock([8, 8, 8, 8], 1)));
    }

    #[test]
    fn deny_overrides_allow() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allowed_cidrs: vec!["10.0.0.0/8".into()],
            denied_cidrs: vec!["10.99.0.0/16".into()],
            allowed_ports: vec![],
            allow_loopback: false,
        })
        .unwrap();
        assert!(p.allows_socket(sock([10, 1, 2, 3], 9)));
        assert!(!p.allows_socket(sock([10, 99, 1, 1], 9)));
    }

    #[test]
    fn deny_alone_blocks_range() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allowed_cidrs: vec![],
            denied_cidrs: vec!["203.0.113.0/24".into()],
            allowed_ports: vec![],
            allow_loopback: true,
        })
        .unwrap();
        assert!(p.is_restricted());
        assert!(!p.allows_socket(sock([203, 0, 113, 9], 80)));
        assert!(p.allows_socket(sock([8, 8, 8, 8], 80)));
    }

    #[test]
    fn deny_blocks_loopback_even_when_allow_loopback() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allowed_cidrs: vec!["10.0.0.0/8".into()],
            denied_cidrs: vec!["127.0.0.0/8".into()],
            allowed_ports: vec![],
            allow_loopback: true,
        })
        .unwrap();
        assert!(!p.allows_socket(sock([127, 0, 0, 1], 9)));
    }

    #[test]
    fn source_port_allowlist_for_single_machine() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allowed_cidrs: vec![],
            denied_cidrs: vec![],
            allowed_ports: vec![18001, 18002],
            allow_loopback: true,
        })
        .unwrap();
        assert!(p.allows_socket(sock([127, 0, 0, 1], 18001)));
        assert!(p.allows_socket(sock([127, 0, 0, 1], 18002)));
        assert!(!p.allows_socket(sock([127, 0, 0, 1], 18003)));
        assert!(!p.allows_socket(sock([10, 0, 0, 5], 9999)));
    }

    #[test]
    fn port_and_cidr_both_required() {
        let p = NetworkPolicy::parse(NetworkPolicyConfig {
            allowed_cidrs: vec!["10.0.0.0/8".into()],
            denied_cidrs: vec![],
            allowed_ports: vec![4000],
            allow_loopback: false,
        })
        .unwrap();
        assert!(p.allows_socket(sock([10, 0, 0, 1], 4000)));
        assert!(!p.allows_socket(sock([10, 0, 0, 1], 4001)));
        assert!(!p.allows_socket(sock([11, 0, 0, 1], 4000)));
    }

    #[test]
    fn bare_ip_is_host_route() {
        let p = NetworkPolicy::parse_allow(&["203.0.113.9".into()], false).unwrap();
        assert!(p.allows_socket(sock([203, 0, 113, 9], 1)));
        assert!(!p.allows_socket(sock([203, 0, 113, 10], 1)));
    }

    #[test]
    fn loopback_bypasses_allow_cidr_when_enabled() {
        let p = NetworkPolicy::parse_allow(&["10.0.0.0/8".into()], true).unwrap();
        assert!(p.allows_socket(sock([127, 0, 0, 1], 9)));
        assert!(p.allows_socket(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 9)));
        assert!(!p.allows_socket(sock([8, 8, 8, 8], 9)));
    }

    #[test]
    fn ipv4_mapped_v6_matches_v4_cidr() {
        let p = NetworkPolicy::parse_allow(&["10.0.0.0/8".into()], false).unwrap();
        let mapped = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x0a01, 0x0203));
        assert!(p.allows_socket(SocketAddr::new(mapped, 1)));
    }

    #[test]
    fn open_bind_detection() {
        assert!(is_open_bind("0.0.0.0"));
        assert!(is_open_bind("::"));
        assert!(!is_open_bind("127.0.0.1"));
    }
}
