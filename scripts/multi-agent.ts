#!/usr/bin/env bun
/**
 * Multi-agent OpenCode harness for Chorus.
 *
 * Spins up N isolated OpenCode servers on one machine, each with the Chorus
 * plugin loaded, then can drive share/join via the OpenCode HTTP API.
 *
 * Usage:
 *   bun scripts/multi-agent.ts setup [--agents N]
 *   bun scripts/multi-agent.ts up [--agents N]
 *   bun scripts/multi-agent.ts down
 *   bun scripts/multi-agent.ts status
 *   bun scripts/multi-agent.ts smoke          # tools registered + health
 *   bun scripts/multi-agent.ts pair          # host share + joiners join
 *   bun scripts/multi-agent.ts relay-stress  # N protocol joiners (no OpenCode)
 *
 * Env:
 *   AGENTS                 number of agents (default 2)
 *   OPENCODE_BIN           path to opencode (default: PATH / ~/.opencode/bin)
 *   OPENCODE_BASE_PORT     first OpenCode serve port (default 4100)
 *   CHORUS_BASE_PORT       host relay port (default 7742); only host uses this
 *   CHORUS_RELAY_BIN       path to chorus-relay binary
 *   MULTI_AGENT_DIR        workspace root (default <repo>/.multi-agent)
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
  readdirSync,
  openSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { RelayServer } from "../packages/plugin/src/relay/index.js";
import { JoinClient } from "../packages/plugin/src/join/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(REPO_ROOT, ".multi-agent");

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
    if (a === "--agents" || a === "-n") {
      agents = parseInt(argv[++i] ?? "2", 10);
    } else if (a === "--role") {
      role = (argv[++i] as Args["role"]) ?? "edit";
    }
  }
  return { command, agents: Math.max(1, agents), role };
}

function rootDir(): string {
  return resolve(process.env["MULTI_AGENT_DIR"] ?? DEFAULT_DIR);
}

function baseOpenCodePort(): number {
  return parseInt(process.env["OPENCODE_BASE_PORT"] ?? "4100", 10);
}

function chorusPort(): number {
  return parseInt(process.env["CHORUS_BASE_PORT"] ?? process.env["CHORUS_PORT"] ?? "7742", 10);
}

function findOpenCode(): string {
  if (process.env["OPENCODE_BIN"]) return process.env["OPENCODE_BIN"];
  const home = process.env["HOME"] ?? "";
  const candidates = [
    join(home, ".opencode/bin/opencode"),
    join(home, ".local/bin/opencode"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const which = Bun.spawnSync(["bash", "-lc", "command -v opencode"]);
  const path = which.stdout.toString().trim();
  if (which.exitCode === 0 && path) return path;
  throw new Error(
    "opencode not found. Install from https://opencode.ai/docs or set OPENCODE_BIN."
  );
}

function relayBin(): string {
  if (process.env["CHORUS_RELAY_BIN"]) return process.env["CHORUS_RELAY_BIN"];
  for (const p of [
    join(REPO_ROOT, "target/release/chorus-relay"),
    join(REPO_ROOT, "target/debug/chorus-relay"),
  ]) {
    if (existsSync(p)) return p;
  }
  return "chorus-relay";
}

function agentDir(i: number): string {
  return join(rootDir(), "agents", `agent-${i}`);
}

function statePath(): string {
  return join(rootDir(), "state.json");
}

type AgentState = {
  index: number;
  name: string;
  dir: string;
  openCodePort: number;
  chorusPort: number | null;
  pid: number;
  url: string;
  role: "host" | "joiner";
};

type HarnessState = {
  createdAt: string;
  agents: AgentState[];
};

function loadState(): HarnessState | null {
  if (!existsSync(statePath())) return null;
  return JSON.parse(readFileSync(statePath(), "utf8")) as HarnessState;
}

function saveState(state: HarnessState): void {
  mkdirSync(rootDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

async function ensureBuilt(): Promise<void> {
  const relay = relayBin();
  if (relay === "chorus-relay" || !existsSync(relay)) {
    console.log("→ building chorus-relay (release)…");
    const r = Bun.spawnSync(["cargo", "build", "-p", "chorus-relay", "--release"], {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (r.exitCode !== 0) throw new Error("cargo build failed");
  }
  console.log("→ building TypeScript packages…");
  const t = Bun.spawnSync(["bun", "run", "build:ts"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (t.exitCode !== 0) throw new Error("build:ts failed");
}

function setupAgentWorkspace(i: number): void {
  const dir = agentDir(i);
  const configDir = join(dir, "xdg-config", "opencode");
  const dataDir = join(dir, "xdg-data");
  const pluginsDir = join(dir, ".opencode", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(join(configDir, "commands"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Local plugin loader — relative import into the monorepo build output.
  // agents/agent-N/.opencode/plugins → ../../../../../packages/plugin/dist
  writeFileSync(
    join(pluginsDir, "chorus.ts"),
    `export { default } from "../../../../../packages/plugin/dist/index.js";\n`
  );

  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n"
  );

  writeFileSync(
    join(dir, "README.md"),
    `# Chorus multi-agent workspace (agent-${i})\n\nAuto-generated by scripts/multi-agent.ts.\n`
  );

  const cmdSrc = join(REPO_ROOT, "packages/plugin/commands");
  for (const file of readdirSync(cmdSrc).filter((f) => f.endsWith(".md"))) {
    cpSync(join(cmdSrc, file), join(configDir, "commands", file));
  }

  writeFileSync(
    join(dir, "agent.env"),
    [
      `AGENT_INDEX=${i}`,
      `AGENT_NAME=agent-${i}`,
      `AGENT_ROLE=${i === 0 ? "host" : "joiner"}`,
      `OPENCODE_PORT=${baseOpenCodePort() + i}`,
      ...(i === 0 ? [`CHORUS_PORT=${chorusPort()}`] : []),
      `CHORUS_RELAY_BIN=${relayBin()}`,
      `XDG_CONFIG_HOME=${join(dir, "xdg-config")}`,
      `XDG_DATA_HOME=${join(dir, "xdg-data")}`,
      `OPENCODE_CONFIG_DIR=${configDir}`,
      "",
    ].join("\n")
  );
}

async function cmdSetup(args: Args): Promise<void> {
  await ensureBuilt();
  mkdirSync(rootDir(), { recursive: true });
  for (let i = 0; i < args.agents; i++) {
    setupAgentWorkspace(i);
    console.log(`✓ agent-${i} → ${agentDir(i)}`);
  }
  console.log(`\nSetup complete under ${rootDir()}`);
  console.log(`Next: bun scripts/multi-agent.ts up --agents ${args.agents}`);
}

async function waitHealth(url: string, timeoutMs = 20000): Promise<void> {
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
    await Bun.sleep(200);
  }
  throw new Error(`OpenCode server not healthy: ${url}`);
}

function readAgentEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const envFile = join(dir, "agent.env");
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  env["CHORUS_RELAY_BIN"] = relayBin();
  return env;
}

async function cmdUp(args: Args): Promise<void> {
  await ensureBuilt();
  const existing = loadState();
  if (existing?.agents?.length) {
    console.log("Harness already up. Run `down` first, or `status`.");
    process.exit(1);
  }

  for (let i = 0; i < args.agents; i++) {
    if (!existsSync(agentDir(i))) setupAgentWorkspace(i);
  }

  const openCode = findOpenCode();
  const agents: AgentState[] = [];
  const logDir = join(rootDir(), "logs");
  mkdirSync(logDir, { recursive: true });

  for (let i = 0; i < args.agents; i++) {
    const dir = agentDir(i);
    const port = baseOpenCodePort() + i;
    const isHost = i === 0;
    const env = readAgentEnv(dir);
    if (isHost) env["CHORUS_PORT"] = String(chorusPort());
    else delete env["CHORUS_PORT"];

    const logPath = join(logDir, `agent-${i}.log`);
    const logFd = openSync(logPath, "w");
    const child = nodeSpawn(
      openCode,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: dir,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      }
    );
    child.unref();

    const url = `http://127.0.0.1:${port}`;
    console.log(`→ starting agent-${i} on ${url} (log: ${logPath})`);
    await waitHealth(url);
    agents.push({
      index: i,
      name: `agent-${i}`,
      dir,
      openCodePort: port,
      chorusPort: isHost ? chorusPort() : null,
      pid: child.pid!,
      url,
      role: isHost ? "host" : "joiner",
    });
  }

  saveState({ createdAt: new Date().toISOString(), agents });
  console.log("\nAll agents up:\n");
  for (const a of agents) {
    console.log(
      `  ${a.name.padEnd(10)} ${a.role.padEnd(7)} opencode=${a.url}` +
        (a.chorusPort ? ` chorus=:${a.chorusPort}` : "")
    );
  }
  console.log(`\nAttach TUI:  opencode attach ${agents[0]!.url}`);
  console.log(`Pair test:   bun scripts/multi-agent.ts pair`);
  console.log(`Tear down:   bun scripts/multi-agent.ts down`);
}

async function cmdDown(): Promise<void> {
  const state = loadState();
  if (!state) {
    console.log("No harness state found.");
    return;
  }
  for (const a of state.agents) {
    try {
      process.kill(a.pid, "SIGTERM");
      console.log(`✓ stopped ${a.name} (pid ${a.pid})`);
    } catch {
      console.log(`· ${a.name} already stopped`);
    }
  }
  try {
    Bun.spawnSync([
      "bash",
      "-lc",
      `pkill -f 'chorus-relay.*--port ${chorusPort()}' || true`,
    ]);
  } catch {
    // ignore
  }
  rmSync(statePath(), { force: true });
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

async function cmdStatus(): Promise<void> {
  const state = loadState();
  if (!state) {
    console.log("No harness running (missing state.json).");
    process.exit(1);
  }
  for (const a of state.agents) {
    let health = "down";
    let tools: string[] = [];
    try {
      const h = await api<{ healthy: boolean; version: string }>(a.url, "/global/health");
      health = h.healthy ? `ok v${h.version}` : "unhealthy";
      tools = await api<string[]>(a.url, "/experimental/tool/ids");
    } catch (e) {
      health = `error: ${(e as Error).message}`;
    }
    const chorusTools = tools.filter((t) => t.startsWith("chorus-"));
    console.log(
      `${a.name}  ${a.role}  ${a.url}  ${health}  chorus-tools=[${chorusTools.join(", ")}]`
    );
  }
}

async function cmdSmoke(): Promise<void> {
  const state = loadState();
  if (!state) throw new Error("Harness not up. Run `up` first.");
  let failed = 0;
  for (const a of state.agents) {
    const h = await api<{ healthy: boolean }>(a.url, "/global/health");
    const tools = await api<string[]>(a.url, "/experimental/tool/ids");
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
      console.error(`✗ ${a.name}: healthy=${h.healthy} missing=${missing.join(",") || "none"}`);
      failed++;
    } else {
      console.log(`✓ ${a.name}: healthy, all chorus tools registered`);
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
  const state = loadState();
  if (!state || state.agents.length < 2) {
    throw new Error("Need at least 2 agents up. Run: bun scripts/multi-agent.ts up --agents 2");
  }

  const host = state.agents.find((a) => a.role === "host") ?? state.agents[0]!;
  const joiners = state.agents.filter((a) => a.index !== host.index);

  console.log(`→ creating host session on ${host.url}`);
  const hostSession = await api<{ id: string }>(host.url, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "chorus-multi-agent-host" }),
  });

  console.log(`→ /chorus-share ${args.role}`);
  const share = await runCommand(host.url, hostSession.id, "chorus-share", args.role);
  console.log(share.text || "(no text parts)");
  if (!share.text) console.log(JSON.stringify(share.raw, null, 2).slice(0, 800));

  const join = extractJoinCommand(share.text);
  if (!join) {
    throw new Error(
      "Could not parse /chorus-join from share response. Is a model configured? Free OpenCode models usually work."
    );
  }
  console.log(`✓ share ok  token=${join.token.slice(0, 12)}…  host=${join.host}`);

  // Prefer loopback for same-machine joiners.
  const joinHost = `127.0.0.1:${chorusPort()}`;

  for (const j of joiners) {
    console.log(`→ ${j.name} joining via ${joinHost}`);
    const sess = await api<{ id: string }>(j.url, "/session", {
      method: "POST",
      body: JSON.stringify({ title: `chorus-joiner-${j.index}` }),
    });
    // Slash command template expects: token host [name]
    const positional = `${join.token} ${joinHost} ${j.name}`;
    const result = await runCommand(j.url, sess.id, "chorus-join", positional);
    console.log(result.text || JSON.stringify(result.raw).slice(0, 400));

    const status = await runCommand(j.url, sess.id, "chorus-status", "");
    console.log(`  status: ${status.text.replace(/\s+/g, " ").slice(0, 240)}`);
  }

  const hostStatus = await runCommand(host.url, hostSession.id, "chorus-status", "");
  console.log(`\nHost status:\n${hostStatus.text}`);

  if (joiners[0]) {
    const j = joiners[0];
    const sessions = await api<Array<{ id: string }>>(j.url, "/session");
    const sid = sessions[0]?.id;
    if (sid) {
      console.log(`→ ${j.name} sending chorus-chat`);
      const chat = await runCommand(j.url, sid, "chorus-chat", "hello from multi-agent harness");
      console.log(chat.text.slice(0, 300));
    }
  }

  console.log("\nPair flow complete. Servers left running — `down` when finished.");
}

async function cmdRelayStress(args: Args): Promise<void> {
  await ensureBuilt();
  const port = 19000 + Math.floor(Math.random() * 500);
  const relay = new RelayServer(port);
  await relay.start();
  console.log(`→ relay on :${port}`);

  const received: string[] = [];
  relay.setInputHandler(async (content, userId, name) => {
    received.push(`${name ?? userId}:${content}`);
  });

  const token = (await relay.issueToken("stress-sess", "edit")).token;
  const clients: JoinClient[] = [];
  const n = args.agents;

  for (let i = 0; i < n; i++) {
    const jc = new JoinClient(`ws://127.0.0.1:${port}/ws`, token, `joiner-${i}`);
    await jc.connect();
    clients.push(jc);
  }
  console.log(`✓ ${n} joiners connected`);

  for (let i = 0; i < n; i++) {
    clients[i]!.sendInput(`ping-from-${i}`);
  }

  const deadline = Date.now() + 3000;
  while (received.length < n && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  for (const c of clients) c.disconnect();
  relay.stop();

  if (received.length !== n) {
    console.error(`✗ expected ${n} inputs, got ${received.length}:`, received);
    process.exit(1);
  }
  console.log(`✓ relay-stress passed (${n} concurrent joiners)`);
}

function cmdHelp(): void {
  console.log(`Chorus multi-agent harness

Commands:
  setup [--agents N]     Create isolated agent workspaces + build
  up [--agents N]        Start N opencode serve processes
  down                   Stop all harness processes
  status                 Health + chorus tool registration
  smoke                  Assert all agents healthy with chorus tools
  pair [--role edit]     Host /chorus-share + joiners /chorus-join
  relay-stress [-n N]    Concurrent JoinClients against Rust relay (no OpenCode)
  help                   Show this help

Examples:
  bun scripts/multi-agent.ts setup --agents 3
  bun scripts/multi-agent.ts up --agents 3
  bun scripts/multi-agent.ts smoke
  bun scripts/multi-agent.ts pair
  bun scripts/multi-agent.ts down
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "setup":
      await cmdSetup(args);
      break;
    case "up":
      await cmdUp(args);
      break;
    case "down":
      await cmdDown();
      break;
    case "status":
      await cmdStatus();
      break;
    case "smoke":
      await cmdSmoke();
      break;
    case "pair":
      await cmdPair(args);
      break;
    case "relay-stress":
      await cmdRelayStress(args);
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
