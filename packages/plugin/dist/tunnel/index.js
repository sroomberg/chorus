// LAN-only in the MVP. Remote tunnel support (bore/cloudflared) is reserved for a future phase.
// The relay server binds according to relay.bind / CHORUS_BIND (default 0.0.0.0).
// Use relay.allowedCidrs + VPN/VPC controls for off-LAN lockdown — see docs/NETWORK.md.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function openTunnel(_localPort) {
    throw new Error("Remote tunneling is not yet implemented. Share your LAN IP and port directly.");
}
//# sourceMappingURL=index.js.map