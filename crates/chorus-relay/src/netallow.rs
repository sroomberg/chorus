//! TCP peer allowlisting by CIDR (IPv4/IPv6).
//!
//! Empty allowlist = no restriction (LAN-friendly default).
//! When non-empty, only matching peers are admitted (plus loopback when enabled).

use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct NetworkAllowlist {
    nets: Vec<IpNet>,
    allow_loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowlistError {
    InvalidCidr(String),
}

impl std::fmt::Display for AllowlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllowlistError::InvalidCidr(s) => write!(f, "invalid CIDR: {s}"),
        }
    }
}

impl std::error::Error for AllowlistError {}

impl NetworkAllowlist {
    /// Parse CIDR strings (also accepts bare IPs as /32 or /128).
    pub fn parse(cidrs: &[String], allow_loopback: bool) -> Result<Self, AllowlistError> {
        let mut nets = Vec::with_capacity(cidrs.len());
        for raw in cidrs {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let net = parse_cidr_or_ip(trimmed)
                .map_err(|_| AllowlistError::InvalidCidr(trimmed.to_string()))?;
            nets.push(net);
        }
        Ok(Self {
            nets,
            allow_loopback,
        })
    }

    pub fn is_restricted(&self) -> bool {
        !self.nets.is_empty()
    }

    pub fn cidrs(&self) -> impl Iterator<Item = String> + '_ {
        self.nets.iter().map(|n| n.to_string())
    }

    pub fn allows(&self, addr: IpAddr) -> bool {
        if self.nets.is_empty() {
            return true;
        }
        if self.allow_loopback && is_loopback(addr) {
            return true;
        }
        let addr = normalize_mapped_v4(addr);
        self.nets.iter().any(|net| net.contains(&addr))
    }

    pub fn allows_socket(&self, addr: SocketAddr) -> bool {
        self.allows(addr.ip())
    }
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

/// Treat `:ffff:x.x.x.x` as the embedded IPv4 for allowlist matching.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn empty_allowlist_admits_everyone() {
        let al = NetworkAllowlist::parse(&[], true).unwrap();
        assert!(!al.is_restricted());
        assert!(al.allows(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn cidr_match_and_miss() {
        let al = NetworkAllowlist::parse(&["10.0.0.0/8".into(), "192.168.1.0/24".into()], false)
            .unwrap();
        assert!(al.allows(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3))));
        assert!(al.allows(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50))));
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::new(192, 168, 2, 1))));
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn bare_ip_is_host_route() {
        let al = NetworkAllowlist::parse(&["203.0.113.9".into()], false).unwrap();
        assert!(al.allows(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9))));
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10))));
    }

    #[test]
    fn loopback_bypasses_when_enabled() {
        let al = NetworkAllowlist::parse(&["10.0.0.0/8".into()], true).unwrap();
        assert!(al.allows(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(al.allows(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn loopback_denied_when_disabled() {
        let al = NetworkAllowlist::parse(&["10.0.0.0/8".into()], false).unwrap();
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[test]
    fn ipv4_mapped_v6_matches_v4_cidr() {
        let al = NetworkAllowlist::parse(&["10.0.0.0/8".into()], false).unwrap();
        let mapped = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x0a01, 0x0203));
        assert!(al.allows(mapped));
    }

    #[test]
    fn tailscale_cg_nat_range() {
        let al = NetworkAllowlist::parse(&["100.64.0.0/10".into()], true).unwrap();
        assert!(al.allows(IpAddr::V4(Ipv4Addr::new(100, 100, 1, 2))));
        assert!(!al.allows(IpAddr::V4(Ipv4Addr::new(101, 0, 0, 1))));
    }

    #[test]
    fn invalid_cidr_errors() {
        let err = NetworkAllowlist::parse(&["not-a-cidr".into()], true).unwrap_err();
        assert!(matches!(err, AllowlistError::InvalidCidr(_)));
    }

    #[test]
    fn open_bind_detection() {
        assert!(is_open_bind("0.0.0.0"));
        assert!(is_open_bind("::"));
        assert!(is_open_bind("[::]"));
        assert!(!is_open_bind("127.0.0.1"));
        assert!(!is_open_bind("10.0.0.5"));
    }
}
