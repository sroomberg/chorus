#!/usr/bin/env bun
/**
 * Cross-adapter relay e2e — exercises the same `@chorus/client` stack the VS Code
 * extension and OpenCode terminal plugin share.
 *
 * Three cloud-environment roles (set CHORUS_E2E_ROLE):
 *   host-vscode        — env1: VS Code-style host (RelayServer + email/approval policy)
 *   joiner-vscode      — env2: VS Code-style joiner (JoinClient, approved, collab.input)
 *   disallowed-joiner  — env3: join attempt rejected (wrong email domain)
 *
 * Default role `local` runs all scenarios in one process:
 *   1. Three-env gate (host vscode + joiner vscode + disallowed joiner)
 *   2. VS Code host relay joined by terminal (OpenCode) JoinClient
 *   3. Terminal host relay joined by VS Code JoinClient
 *
 * Coordination file: CHORUS_E2E_STATE (default /tmp/chorus-vscode-relay-e2e.json)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { JoinClient, RelayServer } from "../packages/client/src/index.ts";

type E2eState = {
  port: number;
  token: string;
  host: string;
  allowedEmailDomain: string;
  pendingUserId?: string;
  phase: "host-ready" | "joiner-done" | "disallowed-done" | "complete";
};

const STATE_PATH = process.env["CHORUS_E2E_STATE"] ?? "/tmp/chorus-vscode-relay-e2e.json";
const ROLE = process.env["CHORUS_E2E_ROLE"] ?? "local";
const PORT = parseInt(process.env["CHORUS_VSCODE_RELAY_E2E_PORT"] ?? "18743", 10);
const EMAIL_DOMAIN = "chorus.test";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn: () => boolean, label: string, ms = 12_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(40);
  }
  throw new Error(`timeout: ${label}`);
}

async function expectReject(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected ${label} to fail`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/expected .+ to fail/.test(msg)) throw err;
    console.log(`  ${label}: ${msg.slice(0, 120)}`);
  }
}

function readState(): E2eState {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`Missing state file ${STATE_PATH} — run host-vscode first`);
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as E2eState;
}

function writeState(state: E2eState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** VS Code extension share path: RelayServer + session policy + token issue. */
async function vscodeHostShare(relay: RelayServer): Promise<{ token: string; port: number }> {
  relay.setSessionPolicy({
    requireApproval: true,
    allowedEmailDomain: EMAIL_DOMAIN,
  });
  const token = (await relay.issueToken("vscode-relay-e2e", "edit")).token;
  return { token, port: relay.getPort() };
}

async function runHostVscode(): Promise<void> {
  const relay = new RelayServer(PORT);
  await relay.start();
  console.log(`[env1 host-vscode] relay listening on 127.0.0.1:${PORT}`);

  const { token, port } = await vscodeHostShare(relay);
  writeState({
    port,
    token,
    host: "127.0.0.1",
    allowedEmailDomain: EMAIL_DOMAIN,
    phase: "host-ready",
  });
  console.log(`[env1 host-vscode] token issued — waiting for joiners (state → ${STATE_PATH})`);

  await waitUntil(() => {
    const s = readState();
    return s.phase === "complete";
  }, "all joiner phases");

  await relay.stop();
  console.log("[env1 host-vscode] complete");
}

async function runJoinerVscode(): Promise<void> {
  const state = readState();
  if (state.phase !== "host-ready" && state.phase !== "joiner-done") {
    await waitUntil(() => readState().phase === "host-ready", "host-ready");
  }
  const { port, token } = readState();

  console.log(`[env2 joiner-vscode] connecting to ws://127.0.0.1:${port}/ws`);
  const jc = new JoinClient(
    `ws://127.0.0.1:${port}/ws`,
    token,
    "VscodeJoiner",
    undefined,
    `dev@${EMAIL_DOMAIN}`
  );
  await jc.connect();
  if (jc.getState().status !== "pending") {
    throw new Error(`expected pending, got ${jc.getState().status}`);
  }
  console.log(`[env2 joiner-vscode] pending userId=${jc.getState().userId}`);

  writeState({ ...readState(), pendingUserId: jc.getState().userId, phase: "host-ready" });

  // Host-side approve happens in local orchestrator or manual step; poll until connected.
  await waitUntil(() => jc.getState().status === "connected", "host approved joiner", 20_000);
  console.log("[env2 joiner-vscode] admitted");

  jc.sendInput("prompt-from-vscode-joiner");
  await sleep(200);
  jc.disconnect();

  writeState({ ...readState(), phase: "joiner-done" });
  console.log("[env2 joiner-vscode] complete");
}

async function runDisallowedJoiner(): Promise<void> {
  await waitUntil(() => {
    const s = existsSync(STATE_PATH) ? readState() : null;
    return Boolean(s && s.phase === "host-ready");
  }, "host-ready for disallowed attempt");

  const { port, token } = readState();
  console.log("[env3 disallowed-joiner] attempting wrong-email join");
  const bad = new JoinClient(
    `ws://127.0.0.1:${port}/ws`,
    token,
    "BlockedUser",
    undefined,
    "intruder@other.test"
  );
  await expectReject(bad.connect(), "wrong-email-domain");
  writeState({ ...readState(), phase: "disallowed-done" });
  console.log("[env3 disallowed-joiner] rejected as expected");
}

async function runLocal(): Promise<void> {
  console.log("=== Scenario A: three-env gate (host vscode / joiner vscode / disallowed) ===");
  const relay = new RelayServer(PORT);
  await relay.start();

  const pendingIds: string[] = [];
  const hostInputs: string[] = [];
  relay.setUserPendingHandler((u) => pendingIds.push(u.userId));
  relay.setInputHandler(async (content) => {
    hostInputs.push(content);
  });

  try {
    const { token } = await vscodeHostShare(relay);
    const wsUrl = `ws://127.0.0.1:${PORT}/ws`;

    console.log("→ env3 disallowed joiner (wrong email)");
    await expectReject(
      new JoinClient(wsUrl, token, "Intruder", undefined, "bad@other.test").connect(),
      "disallowed-email"
    );
    console.log("✓ disallowed joiner rejected");

    console.log("→ env2 joiner vscode (matching email, pending)");
    const vscodeJoiner = new JoinClient(
      wsUrl,
      token,
      "VscodeJoiner",
      undefined,
      `alice@${EMAIL_DOMAIN}`
    );
    await vscodeJoiner.connect();
    if (vscodeJoiner.getState().status !== "pending") {
      throw new Error(`expected pending, got ${vscodeJoiner.getState().status}`);
    }
    await waitUntil(() => pendingIds.length > 0, "env1 host saw pending");
    console.log(`✓ env2 pending userId=${pendingIds[0]}`);

    relay.approveUser(pendingIds[0]!);
    await waitUntil(() => vscodeJoiner.getState().status === "connected", "env2 admitted");
    vscodeJoiner.sendInput("from-vscode-joiner");
    await waitUntil(() => hostInputs.includes("from-vscode-joiner"), "collab.input from vscode joiner");
    console.log("✓ env2 collab.input delivered to env1 host");
    vscodeJoiner.disconnect();
  } finally {
    await relay.stop();
  }

  console.log("\n=== Scenario B: VS Code host ← terminal joiner ===");
  {
    const relay = new RelayServer(PORT + 1);
    await relay.start();
    relay.setSessionPolicy({ requireApproval: false });
    const terminalInputs: string[] = [];
    relay.setInputHandler(async (c) => terminalInputs.push(c));
    try {
      const token = (await relay.issueToken("terminal-join", "edit")).token;
      const terminalJoiner = new JoinClient(`ws://127.0.0.1:${PORT + 1}/ws`, token, "TerminalUser");
      await terminalJoiner.connect();
      terminalJoiner.sendInput("from-terminal-joiner");
      await waitUntil(() => terminalInputs.includes("from-terminal-joiner"), "terminal→vscode-host");
      console.log("✓ terminal joiner reached VS Code-style host relay");
      terminalJoiner.disconnect();
    } finally {
      await relay.stop();
    }
  }

  console.log("\n=== Scenario C: terminal host → VS Code joiner ===");
  {
    const relay = new RelayServer(PORT + 2);
    await relay.start();
    relay.setSessionPolicy({ requireApproval: false });
    const terminalHostInputs: string[] = [];
    relay.setInputHandler(async (c) => terminalHostInputs.push(c));
    try {
      const token = (await relay.issueToken("terminal-host", "edit")).token;
      const vscodeJoiner = new JoinClient(`ws://127.0.0.1:${PORT + 2}/ws`, token, "VscodeJoiner");
      await vscodeJoiner.connect();
      vscodeJoiner.sendInput("from-vscode-to-terminal-host");
      await waitUntil(
        () => terminalHostInputs.includes("from-vscode-to-terminal-host"),
        "vscode→terminal-host"
      );
      console.log("✓ VS Code joiner reached terminal-style host relay");
      vscodeJoiner.disconnect();
    } finally {
      await relay.stop();
    }
  }

  console.log("\n✓ vscode-relay-e2e passed (all scenarios)");
}

async function runDistributedOrchestrator(): Promise<void> {
  // When roles run on separate machines, host must approve after joiner-vscode connects.
  if (ROLE === "host-vscode") {
    const relay = new RelayServer(PORT);
    await relay.start();

    const pendingIds: string[] = [];
    const hostInputs: string[] = [];
    relay.setUserPendingHandler((u) => pendingIds.push(u.userId));
    relay.setInputHandler(async (content) => hostInputs.push(content));

    const { token, port } = await vscodeHostShare(relay);
    writeState({
      port,
      token,
      host: process.env["CHORUS_PUBLIC_HOST"]?.split(":")[0] ?? "127.0.0.1",
      allowedEmailDomain: EMAIL_DOMAIN,
      phase: "host-ready",
    });

    await waitUntil(() => readState().pendingUserId, "joiner pending");
    const userId = readState().pendingUserId!;
    relay.approveUser(userId);
    await waitUntil(() => hostInputs.length > 0, "collab.input from joiner");
    await waitUntil(() => readState().phase === "disallowed-done", "disallowed joiner phase");
    writeState({ ...readState(), phase: "complete" });
    await relay.stop();
    return;
  }

  if (ROLE === "joiner-vscode") {
    await runJoinerVscode();
    return;
  }

  if (ROLE === "disallowed-joiner") {
    await runDisallowedJoiner();
    return;
  }

  throw new Error(`Unknown CHORUS_E2E_ROLE=${ROLE}`);
}

async function main() {
  if (ROLE === "local") {
    await runLocal();
    return;
  }
  await runDistributedOrchestrator();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
