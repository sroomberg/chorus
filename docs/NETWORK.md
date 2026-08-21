# Network access — keep Chorus off the open internet

Chorus is a **self-hosted** WebSocket relay. By default it binds `0.0.0.0:7742` with no IP filter so LAN pair sessions work. Enterprises that must keep the share off the public internet should combine:

1. **Cloud / VPN network controls** (security groups, private subnets, VPN routes) — the primary gate
2. **Chorus CIDR allowlist + bind policy** — defense in depth on the relay process itself

Neither replaces join tokens, approval, or (eventually) SSO. They only answer: *who can even open a TCP connection to the relay?*

## Chorus controls

Configure in `chorus.json` (or `/etc/chorus/config.json` / env):

```json
{
  "relay": {
    "bind": "10.0.12.4",
    "allowOpenBind": false,
    "allowedCidrs": ["10.0.0.0/8", "100.64.0.0/10"],
    "allowLoopback": true
  }
}
```

| Field / env | Default | Meaning |
|---|---|---|
| `relay.bind` / `CHORUS_BIND` | `0.0.0.0` | Listen address |
| `relay.allowOpenBind` / `CHORUS_ALLOW_OPEN_BIND` | `true` | When `false`, refuse bind to `0.0.0.0` / `::` |
| `relay.allowedCidrs` / `CHORUS_ALLOWED_CIDRS` | `[]` | CIDR or IP allow list; empty = no allow restriction |
| `relay.deniedCidrs` / `CHORUS_DENIED_CIDRS` | `[]` | Explicit deny CIDRs (deny wins over allow) |
| `relay.allowedPorts` / `CHORUS_ALLOWED_PORTS` | `[]` | Peer **source port** allowlist; empty = any port |
| `relay.allowLoopback` / `CHORUS_ALLOW_LOOPBACK` | `true` | When allow-CIDRs set, still admit loopback IPs (ports still enforced) |

CLI equivalent when running `chorus-relay` directly:

```sh
chorus-relay \
  --bind 10.0.12.4 \
  --allow-open-bind false \
  --allow-cidr 10.0.0.0/8 \
  --allow-cidr 100.64.0.0/10 \
  --deny-cidr 203.0.113.0/24 \
  --allow-port 18201 \
  --allow-port 18202
```

Evaluation order per TCP peer:

1. **Deny CIDR** match → reject
2. **Allow CIDR** (if non-empty) → must match (loopback may bypass when `allowLoopback`)
3. **Allowed source ports** (if non-empty) → peer source port must be listed
4. Otherwise admit

Source-port allowlisting is how single-machine e2e distinguishes clients that all appear as `127.0.0.1`. See `bun run test:network-e2e`.

Peers outside policy get **HTTP 403** / failed WebSocket upgrade (`NETWORK_ACCESS_DENIED`) before auth. Matching uses the **TCP peer address and source port** (not `X-Forwarded-For`). Put the policy on the process that terminates the client connection, or rely on the edge security group when fronted by a load balancer.

`/status` reports whether a policy is active:

```json
{
  "status": "ok",
  "clients": 0,
  "network": {
    "allowlist": ["10.0.0.0/8"],
    "denylist": ["203.0.113.0/24"],
    "allowedPorts": [18201, 18202],
    "restricted": true
  }
}
```

## Recommended patterns

### Corporate VPN or Zero Trust (any cloud)

1. Require VPN / WARP / GlobalProtect / etc. for developer laptops.
2. Allowlist the VPN egress CIDRs (or the VPN pool) in `allowedCidrs`.
3. Set `allowOpenBind: false` and bind a private interface (or keep `0.0.0.0` only if the host has no public NIC).

Joiners who are not on the VPN never reach the relay, even with a leaked join token.

### Tailscale / WireGuard / Nebula

Allowlist the overlay range (Tailscale CGNAT is typically `100.64.0.0/10`). Advertise `publicHost` as the host’s tailnet IP (or MagicDNS name + port) via `relay.publicHost` / `CHORUS_PUBLIC_HOST`.

```json
{
  "relay": {
    "publicHost": "100.100.1.20:7742",
    "allowedCidrs": ["100.64.0.0/10"],
    "allowOpenBind": false,
    "bind": "100.100.1.20"
  }
}
```

### AWS VPC

Defense in depth:

| Layer | What to set |
|---|---|
| Placement | Run the host (or a dedicated `chorus-relay`) in a **private subnet** with no public IP |
| Security group | Inbound TCP `7742` only from VPN SG, Shared Services SG, or corporate CIDRs — never `0.0.0.0/0` |
| NACL (optional) | Same CIDR allowlist at subnet edge |
| Chorus | `allowedCidrs` = VPC CIDR(s) + VPN client CIDR; `allowOpenBind: false` |

Private connectivity options when joiners are in another account/VPC: **VPC peering**, **Transit Gateway**, or **PrivateLink** to an NLB in front of the relay. Do not put an internet-facing ALB in front of plaintext `ws://` without TLS termination and auth at the edge.

Example MDM floor:

```json
{
  "relay": {
    "allowOpenBind": false,
    "allowedCidrs": ["10.20.0.0/16", "10.30.0.0/16"]
  }
}
```

### Azure VNet

| Layer | What to set |
|---|---|
| Placement | Private subnet; no public IP on the NIC |
| NSG | Allow TCP `7742` from VPN Gateway / Virtual WAN hub / peered VNet ranges only |
| Private Link | Optional Private Endpoint + Internal Load Balancer if the relay is a shared service |
| Chorus | `allowedCidrs` = VNet address spaces + VPN point-to-site pool |

### GCP VPC

| Layer | What to set |
|---|---|
| Placement | Private GCE / GKE with no external IP (Cloud NAT for egress if needed) |
| Firewall | Ingress `tcp:7742` from VPN (`Cloud VPN` / `Identity-Aware Proxy` is not a TCP peer substitute) or specific source tags/ranges |
| PSC | Private Service Connect for cross-project relay |
| Chorus | `allowedCidrs` = subnet CIDRs + HA VPN client ranges |

## What this does *not* do

- It does **not** terminate TLS (still `ws://` until tunnel/TLS work lands).
- It does **not** verify IdP identity — pair with join token + approval / future OIDC.
- It does **not** replace cloud security groups; treat Chorus allowlists as a second fence.
- Behind a reverse proxy, the relay sees the **proxy’s** IP unless you terminate allowlisting at the proxy.

See also [ENTERPRISE.md](./ENTERPRISE.md) for the full security gap list.
