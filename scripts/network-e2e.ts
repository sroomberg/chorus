#!/usr/bin/env bun
/**
 * Network-constraint e2e (single-machine).
 *
 * Spawns chorus-relay with:
 *   - source-port allowlist: PORT_A + PORT_B admitted, PORT_C denied
 *   - deny CIDR: 203.0.113.0/24 (documentation range; not exercised on loopback)
 *   - then a second relay with deny 127.0.0.0/8 to prove deny wins on loopback
 *
 * Clients bind fixed local ports so peers are distinguishable on 127.0.0.1.
 *
 * Usage:
 *   bun run test:network-e2e
 *   # or: bun scripts/network-e2e.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_PORT = parseInt(process.env["NETWORK_E2E_RELAY_PORT"] ?? "18780", 10);
const PORT_A = parseInt(process.env["NETWORK_E2E_PORT_A"] ?? "18201", 10);
const PORT_B = parseInt(process.env["NETWORK_E2E_PORT_B"] ?? "18202", 10);
const PORT_C = parseInt(process.env["NETWORK_E2E_PORT_C"] ?? "18203", 10);
const DENY_RELAY_PORT = RELAY_PORT + 1;

function resolveRelayBin(): string {
  if (process.env["CHORUS_RELAY_BIN"]) return process.env["CHORUS_RELAY_BIN"];
  for (const p of [
    join(REPO, "target/release/chorus-relay"),
    join(REPO, "target/debug/chorus-relay"),
  ]) {
    if (existsSync(p)) return p;
  }
  return "chorus-relay";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any TCP accept means the listener is up (status may be 403 under policy).
      await new Promise<void>((resolve, reject) => {
        const s = createConnection({ host: "127.0.0.1", port }, () => {
          s.end();
          resolve();
        });
        s.on("error", reject);
      });
      return;
    } catch {
      await sleep(40);
    }
  }
  throw new Error(`relay not ready on ${port}`);
}

function startRelay(args: string[]): { child: ChildProcess; hostToken: string } {
  const hostToken = randomBytes(32).toString("hex");
  const bin = resolveRelayBin();
  const child = spawn(
    bin,
    ["--port", String(args[0]), "--bind", "127.0.0.1", "--host-token", hostToken, ...args.slice(1)],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  child.stderr?.on("data", () => {});
  return { child, hostToken };
}

async function httpStatus(
  relayPort: number,
  localPort: number
): Promise<{ status: number; body: string; peerPort: number }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({
      host: "127.0.0.1",
      port: relayPort,
      localAddress: "127.0.0.1",
      localPort,
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`GET /status HTTP/1.0\r\nHost: 127.0.0.1:${relayPort}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("end", () => {
      const status = parseInt(buf.split(" ")[1] ?? "0", 10) || 0;
      resolve({ status, body: buf, peerPort: localPort });
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout talking to relay from local port ${localPort}`));
    }, 5000).unref?.();
  });
}

async function wsUpgrade(
  relayPort: number,
  localPort: number
): Promise<{ ok: boolean; status: number; body: string }> {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: relayPort,
      localAddress: "127.0.0.1",
      localPort,
    });
    let buf = Buffer.alloc(0);
    socket.on("connect", () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      const status = parseInt(text.split(" ")[1] ?? "0", 10) || 0;
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      const ok = status === 101 && text.includes(accept);
      socket.destroy();
      resolve({ ok, status, body: text.slice(0, 300) });
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error(`ws timeout from local port ${localPort}`));
    }, 5000).unref?.();
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function scenarioPortAllowlist(): Promise<void> {
  console.log(`\n→ scenario: source ports A=${PORT_A} B=${PORT_B} allow, C=${PORT_C} deny`);
  const { child } = startRelay([
    String(RELAY_PORT),
    "--allow-port",
    String(PORT_A),
    "--allow-port",
    String(PORT_B),
    "--deny-cidr",
    "203.0.113.0/24",
  ]);
  try {
    await waitReady(RELAY_PORT);
    const status = await httpStatus(RELAY_PORT, PORT_A);
    assert(status.status === 200, `A /status expected 200, got ${status.status}`);
    assert(status.body.includes('"restricted":true'), "status should report restricted");
    assert(status.body.includes("18201") || status.body.includes(String(PORT_A)), "status lists ports");

    const a = await wsUpgrade(RELAY_PORT, PORT_A);
    assert(a.ok, `port A ws should upgrade: ${a.status} ${a.body}`);
    console.log(`  ✓ port A (${PORT_A}) admitted`);

    const b = await wsUpgrade(RELAY_PORT, PORT_B);
    assert(b.ok, `port B ws should upgrade: ${b.status} ${b.body}`);
    console.log(`  ✓ port B (${PORT_B}) admitted`);

    const cHttp = await httpStatus(RELAY_PORT, PORT_C);
    assert(cHttp.status === 403, `port C /status expected 403, got ${cHttp.status}`);
    const cWs = await wsUpgrade(RELAY_PORT, PORT_C).catch((e) => ({
      ok: false,
      status: 0,
      body: String(e),
    }));
    assert(!cWs.ok && (cWs.status === 403 || cWs.status === 0), `port C ws should fail, got ${cWs.status}`);
    console.log(`  ✓ port C (${PORT_C}) denied`);
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
}

async function scenarioDenyLoopback(): Promise<void> {
  console.log(`\n→ scenario: deny 127.0.0.0/8 blocks loopback peers`);
  const { child } = startRelay([String(DENY_RELAY_PORT), "--deny-cidr", "127.0.0.0/8"]);
  try {
    await waitReady(DENY_RELAY_PORT);
    const res = await httpStatus(DENY_RELAY_PORT, PORT_A);
    assert(res.status === 403, `deny loopback expected 403, got ${res.status}: ${res.body}`);
    console.log(`  ✓ deny CIDR blocked loopback (403)`);
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
}

async function main() {
  console.log(`network-e2e using ${resolveRelayBin()}`);
  await scenarioPortAllowlist();
  await scenarioDenyLoopback();
  console.log("\n✓ network-e2e passed");
}

main().catch((err) => {
  console.error("\n✗ network-e2e failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
