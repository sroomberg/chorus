#!/usr/bin/env bun
/**
 * Docker multi-agent harness for Chorus.
 *
 * Runs chorus-relay on the host machine and OpenCode agents in containers
 * that reach the relay via host.docker.internal.
 *
 * Usage:
 *   bun scripts/docker-agents.ts up [--agents 2|3]
 *   bun scripts/docker-agents.ts smoke
 *   bun scripts/docker-agents.ts pair [--role edit]
 *   bun scripts/docker-agents.ts status
 *   bun scripts/docker-agents.ts down
 *   bun scripts/docker-agents.ts relay-up
 *   bun scripts/docker-agents.ts relay-down
 *
 * Env:
 *   CHORUS_PORT            host relay port (default 7742)
 *   OPENCODE_BASE_PORT     host port for agent-0 (default 4100)
 *   OPENCODE_VERSION       OpenCode version baked into the image
 *   CHORUS_HOST_TOKEN      optional; generated if omitted
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(REPO_ROOT, ".multi-agent");
const RELAY_ENV = join(STATE_DIR, "docker-relay.env");
const STATE_FILE = join(STATE_DIR, "docker-state.json");

type Args = {
  command: string;
  agents: number;
  role: "edit" | "view" | "admin";
};

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? "help";
  let agents = parseInt(process.env["AGENTS"] ?? "2", 10);
  let role: Args["role"] = "edit";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agents" || a === "-n") agents = parseInt(argv[++i] ?? "2", 10);
    else if (a === "--role") role = (argv[++i] as Args["role"]) ?? "edit";
  }
  return { command, agents: Math.min(3, Math.max(2, agents)), role };
}

function chorusPort(): number {
  return parseInt(process.env["CHORUS_PORT"] ?? "7742", 10);
}

function baseOpenCodePort(): number {
  return parseInt(process.env["OPENCODE_BASE_PORT"] ?? "4100", 10);
}

function relayBin(): string {
  if (process.env["CHORUS_RELAY_BIN"]) return process.env["CHORUS_RELAY_BIN"];
  const targetRoot = process.env["CARGO_TARGET_DIR"] ?? join(REPO_ROOT, "target");
  for (const p of [
    join(targetRoot, "release/chorus-relay"),
    join(targetRoot, "debug/chorus-relay"),
    join(REPO_ROOT, "target/release/chorus-relay"),
    join(REPO_ROOT, "target/debug/chorus-relay"),
  ]) {
    if (existsSync(p)) return p;
  }
  return join(targetRoot, "release/chorus-relay");
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {}) {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: opts.inherit === false ? "pipe" : "inherit",
    stderr: opts.inherit === false ? "pipe" : "inherit",
  });
  if (r.exitCode !== 0) {
    const err = opts.inherit === false ? r.stderr.toString() : "";
    throw new Error(`Command failed (${r.exitCode}): ${cmd.join(" ")}${err ? `\n${err}` : ""}`);
  }
  return r;
}

async function ensureBuilt(): Promise<void> {
  if (!existsSync(relayBin())) {
    console.log("→ building chorus-relay…");
    run(["cargo", "build", "-p", "chorus-relay", "--release"]);
  }
  console.log("→ building TypeScript packages…");
  run(["bun", "run", "build:ts"]);
}

type RelayState = {
  pid: number;
  port: number;
  hostToken: string;
  logPath: string;
};

type DockerState = {
  agents: number;
  basePort: number;
  relay: RelayState;
  createdAt: string;
};

function loadRelayEnv(): { hostToken: string; port: number } | null {
  if (!existsSync(RELAY_ENV)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(RELAY_ENV, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (!env["CHORUS_HOST_TOKEN"]) return null;
  return {
    hostToken: env["CHORUS_HOST_TOKEN"],
    port: parseInt(env["CHORUS_PORT"] ?? String(chorusPort()), 10),
  };
}

function saveRelayEnv(hostToken: string, port: number, pid: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    RELAY_ENV,
    [
      `CHORUS_PORT=${port}`,
      `CHORUS_HOST_TOKEN=${hostToken}`,
      `CHORUS_RELAY_PID=${pid}`,
      `CHORUS_RELAY_HOST=host.docker.internal:${port}`,
      `CHORUS_PUBLIC_HOST=host.docker.internal:${port}`,
      `CHORUS_EXTERNAL_RELAY=1`,
      "",
    ].join("\n")
  );
}

async function waitRelay(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }
  throw new Error(`chorus-relay not ready on :${port}`);
}

async function cmdRelayUp(): Promise<RelayState> {
  await ensureBuilt();
  const existing = loadRelayEnv();
  if (existing) {
    try {
      const res = await fetch(`http://127.0.0.1:${existing.port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        console.log(`✓ relay already up on :${existing.port}`);
        const pid = parseInt(
          readFileSync(RELAY_ENV, "utf8").match(/CHORUS_RELAY_PID=(\d+)/)?.[1] ?? "0",
          10
        );
        return {
          pid,
          port: existing.port,
          hostToken: existing.hostToken,
          logPath: join(STATE_DIR, "logs", "relay.log"),
        };
      }
    } catch {
      // stale env — restart
    }
  }

  const port = chorusPort();
  const hostToken = process.env["CHORUS_HOST_TOKEN"] ?? randomBytes(32).toString("hex");
  const logDir = join(STATE_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "relay.log");
  const logFd = openSync(logPath, "w");

  const child: ChildProcess = nodeSpawn(
    relayBin(),
    ["--port", String(port), "--bind", "0.0.0.0", "--host-token", hostToken],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );
  child.unref();

  await waitRelay(port);
  saveRelayEnv(hostToken, port, child.pid!);
  console.log(`✓ chorus-relay on 0.0.0.0:${port} (pid ${child.pid})`);
  console.log(`  token written to ${RELAY_ENV}`);
  console.log(`  log: ${logPath}`);
  return { pid: child.pid!, port, hostToken, logPath };
}

function cmdRelayDown(): void {
  const env = loadRelayEnv();
  if (!env) {
    console.log("No docker-relay.env — nothing to stop.");
    return;
  }
  const pidMatch = readFileSync(RELAY_ENV, "utf8").match(/CHORUS_RELAY_PID=(\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1]!, 10) : 0;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`✓ stopped relay pid ${pid}`);
    } catch {
      console.log(`· relay pid ${pid} already stopped`);
    }
  }
  // Fallback: kill by port bind
  Bun.spawnSync([
    "bash",
    "-lc",
    `pkill -f 'chorus-relay.*--port ${env.port}' || true`,
  ]);
  rmSync(RELAY_ENV, { force: true });
}

async function waitHealth(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean };
        if (body.healthy) return;
      }
    } catch {
      // retry
    }
    await Bun.sleep(250);
  }
  throw new Error(`OpenCode agent not healthy: ${url}`);
}

function composeProfiles(agents: number): string[] {
  return agents >= 3 ? ["--profile", "three"] : [];
}

function composeEnv(relay: RelayState, agents: number): Record<string, string> {
  const base = baseOpenCodePort();
  return {
    CHORUS_PORT: String(relay.port),
    CHORUS_HOST_TOKEN: relay.hostToken,
    OPENCODE_BASE_PORT: String(base),
    OPENCODE_BASE_PORT_1: String(base + 1),
    OPENCODE_BASE_PORT_2: String(base + 2),
    OPENCODE_VERSION: process.env["OPENCODE_VERSION"] ?? "1.18.11",
    AGENTS: String(agents),
  };
}

async function cmdUp(args: Args): Promise<void> {
  await ensureBuilt();
  const relay = await cmdRelayUp();

  console.log("→ building OpenCode agent image…");
  run(
    ["docker", "compose", "build", "agent-0"],
    { env: composeEnv(relay, args.agents) }
  );

  const services = ["agent-0", "agent-1"];
  if (args.agents >= 3) services.push("agent-2");

  console.log(`→ starting ${services.join(", ")}…`);
  run(
    ["docker", "compose", ...composeProfiles(args.agents), "up", "-d", "--no-build", ...services],
    { env: composeEnv(relay, args.agents) }
  );

  const base = baseOpenCodePort();
  for (let i = 0; i < args.agents; i++) {
    const url = `http://127.0.0.1:${base + i}`;
    console.log(`→ waiting for agent-${i} at ${url}`);
    await waitHealth(url);
    console.log(`✓ agent-${i} healthy`);
  }

  const state: DockerState = {
    agents: args.agents,
    basePort: base,
    relay,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log("\nDocker agents up:\n");
  console.log(`  relay     host:0.0.0.0:${relay.port}`);
  for (let i = 0; i < args.agents; i++) {
    const role = i === 0 ? "host  " : "joiner";
    console.log(`  agent-${i}  ${role}  http://127.0.0.1:${base + i}`);
  }
  console.log(`\nPair test:  bun scripts/docker-agents.ts pair`);
  console.log(`Tear down:  bun scripts/docker-agents.ts down`);
}

async function cmdDown(): Promise<void> {
  const relay = loadRelayEnv();
  const env = relay
    ? composeEnv(
        {
          pid: 0,
          port: relay.port,
          hostToken: relay.hostToken,
          logPath: "",
        },
        3
      )
    : {};

  try {
    run(["docker", "compose", "--profile", "three", "down", "--remove-orphans"], {
      env,
    });
  } catch {
    run(["docker", "compose", "down", "--remove-orphans"], { env });
  }
  rmSync(STATE_FILE, { force: true });
  cmdRelayDown();
  console.log("Down.");
}

async function api<T = unknown>(
  base: string,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 120_000;
  const { timeoutMs: _t, ...rest } = init ?? {};
  const res = await fetch(`${base}${path}`, {
    ...rest,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!res.ok) {
    throw new Error(`${rest.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return body as T;
}

function agentUrls(): string[] {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DockerState;
    return Array.from({ length: state.agents }, (_, i) => `http://127.0.0.1:${state.basePort + i}`);
  }
  const n = parseInt(process.env["AGENTS"] ?? "2", 10);
  const base = baseOpenCodePort();
  return Array.from({ length: n }, (_, i) => `http://127.0.0.1:${base + i}`);
}

async function cmdStatus(): Promise<void> {
  for (const [i, url] of agentUrls().entries()) {
    try {
      const h = await api<{ healthy: boolean; version: string }>(url, "/global/health");
      const tools = await api<string[]>(url, "/experimental/tool/ids");
      const chorus = tools.filter((t) => t.startsWith("chorus-"));
      console.log(
        `agent-${i}  ${url}  ok v${h.version}  chorus-tools=[${chorus.join(", ")}]`
      );
    } catch (e) {
      console.log(`agent-${i}  ${url}  error: ${(e as Error).message}`);
    }
  }
  const relay = loadRelayEnv();
  if (relay) {
    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      console.log(`relay     :${relay.port}  ${res.ok ? await res.text() : "down"}`);
    } catch {
      console.log(`relay     :${relay.port}  down`);
    }
  }
}

async function cmdSmoke(): Promise<void> {
  let failed = 0;
  for (const [i, url] of agentUrls().entries()) {
    const h = await api<{ healthy: boolean }>(url, "/global/health");
    const tools = await api<string[]>(url, "/experimental/tool/ids");
    const needed = [
      "chorus-share",
      "chorus-join",
      "chorus-leave",
      "chorus-chat",
      "chorus-status",
      "chorus-stop",
    ];
    const missing = needed.filter((t) => !tools.includes(t));
    if (!h.healthy || missing.length) {
      console.error(`✗ agent-${i}: missing=${missing.join(",") || "none"}`);
      failed++;
    } else {
      console.log(`✓ agent-${i}: healthy, chorus tools registered`);
    }
  }
  if (failed) process.exit(1);
  console.log("\nSmoke passed.");
}

function extractJoinCommand(text: string): { token: string; host: string } | null {
  const m = text.match(/\/chorus-join\s+token="([^"]+)"\s+host="([^"]+)"/);
  if (!m) return null;
  return { token: m[1]!, host: m[2]! };
}

type SessionMessage = {
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; output?: string };
  }>;
};

/** Prefer structured tool output; fall back to assistant text (models paraphrase). */
async function extractShareJoin(
  base: string,
  sessionId: string,
  commandText: string
): Promise<{ token: string; host: string } | null> {
  const fromText = extractJoinCommand(commandText);
  if (fromText) return fromText;

  const messages = await api<SessionMessage[]>(base, `/session/${sessionId}/message`);
  for (const msg of [...messages].reverse()) {
    for (const part of msg.parts ?? []) {
      if (part.type === "tool" && part.tool === "chorus-share" && part.state?.output) {
        try {
          const out = JSON.parse(part.state.output) as { connect?: string; token?: string; url?: string };
          const fromConnect = out.connect ? extractJoinCommand(out.connect) : null;
          if (fromConnect) return fromConnect;
          if (out.token) return { token: out.token, host: out.url ?? "" };
        } catch {
          const fromRaw = extractJoinCommand(part.state.output);
          if (fromRaw) return fromRaw;
        }
      }
      if (part.type === "text" && part.text) {
        const hit = extractJoinCommand(part.text);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function runCommand(
  base: string,
  sessionId: string,
  command: string,
  arguments_: string
): Promise<{ text: string; raw: unknown }> {
  const raw = await api<{ parts?: Array<{ type: string; text?: string }> }>(
    base,
    `/session/${sessionId}/command`,
    {
      method: "POST",
      body: JSON.stringify({ command, arguments: arguments_ }),
    }
  );
  const text = (raw.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
  return { text, raw };
}

async function cmdPair(args: Args): Promise<void> {
  const urls = agentUrls();
  if (urls.length < 2) throw new Error("Need at least 2 agents");

  const hostUrl = urls[0]!;
  const joiners = urls.slice(1);
  const relay = loadRelayEnv();
  const joinHost = relay
    ? `host.docker.internal:${relay.port}`
    : `host.docker.internal:${chorusPort()}`;

  console.log(`→ host session on ${hostUrl}`);
  const hostSession = await api<{ id: string }>(hostUrl, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "chorus-docker-host" }),
  });

  console.log(`→ /chorus-share ${args.role}`);
  const share = await runCommand(hostUrl, hostSession.id, "chorus-share", args.role);
  console.log(share.text || "(no text)");

  const join = await extractShareJoin(hostUrl, hostSession.id, share.text);
  if (!join) {
    throw new Error("Could not parse /chorus-join from share tool output or response text");
  }
  console.log(`✓ share ok  token=${join.token.slice(0, 12)}…  advertised=${join.host}`);
  console.log(`  joiner connect host: ${joinHost}`);

  for (const [idx, url] of joiners.entries()) {
    const name = `agent-${idx + 1}`;
    console.log(`→ ${name} joining via ${joinHost}`);
    const sess = await api<{ id: string }>(url, "/session", {
      method: "POST",
      body: JSON.stringify({ title: `chorus-docker-${name}` }),
    });
    const positional = `${join.token} ${joinHost} ${name}`;
    const result = await runCommand(url, sess.id, "chorus-join", positional);
    console.log(result.text || JSON.stringify(result.raw).slice(0, 400));
  }

  const hostStatus = await runCommand(hostUrl, hostSession.id, "chorus-status", "");
  console.log(`\nHost status:\n${hostStatus.text}`);
  console.log("\nPair flow complete.");
}

function cmdHelp(): void {
  console.log(`Chorus Docker multi-agent harness

  Host machine runs chorus-relay; OpenCode agents run in containers and
  reach the relay via host.docker.internal.

Commands:
  up [--agents 2|3]      Start host relay + container agents
  down                   Stop containers + host relay
  smoke                  Health + chorus tool registration
  pair [--role edit]     Automate /chorus-share + /chorus-join
  status                 Show agent/relay status
  relay-up               Start only the host-side relay
  relay-down             Stop only the host-side relay
  help

Examples:
  bun scripts/docker-agents.ts up --agents 2
  bun scripts/docker-agents.ts smoke
  bun scripts/docker-agents.ts pair
  bun scripts/docker-agents.ts down
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "up":
      await cmdUp(args);
      break;
    case "down":
      await cmdDown();
      break;
    case "smoke":
      await cmdSmoke();
      break;
    case "pair":
      await cmdPair(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "relay-up":
      await cmdRelayUp();
      break;
    case "relay-down":
      cmdRelayDown();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
