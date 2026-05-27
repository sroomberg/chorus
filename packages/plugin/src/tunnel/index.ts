// LAN-only in the MVP. Remote tunnel support (bore/cloudflared) is reserved for a future phase.
// The relay server already binds to 0.0.0.0 so LAN access works without this module.

export interface TunnelInfo {
  publicUrl: string;
  provider: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function openTunnel(_localPort: number): Promise<TunnelInfo> {
  throw new Error(
    "Remote tunneling is not yet implemented. Share your LAN IP and port directly."
  );
}
