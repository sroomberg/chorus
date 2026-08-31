#!/usr/bin/env bun
/**
 * Hybrid live e2e:
 * - OpenCode host: /chorus-share (requireApproval=true) + /chorus-approve
 * - Protocol JoinClient: join pending then admit after approve
 *
 * Requires: bun scripts/multi-agent.ts up --agents 2
 */
import { readFileSync, existsSync } from "node:fs";
import { join as pathJoin, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JoinClient } from "../packages/client/src/index.ts";
import { detectRepoRemote } from "../packages/plugin/src/git.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = pathJoin(REPO, ".multi-agent", "state.json");

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(180_000),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep */
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 500)}`);
  return body as T;
}

async function runCommand(base: string, sessionId: string, command: string, args: string) {
  const raw = await api<{
    parts?: Array<{ type: string; text?: string; state?: { output?: string } }>;
  }>(base, `/session/${sessionId}/command`, {
    method: "POST",
    body: JSON.stringify({ command, arguments: args }),
  });
  const text = (raw.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
  const toolOut = (raw.parts ?? [])
    .filter((p) => p.type === "tool" && p.state?.output)
    .map((p) => p.state!.output!)
    .join("\n");
  return { text, toolOut };
}

function extractToken(text: string): string | null {
  return text.match(/token="([0-9a-f]{64})"/)?.[1] ?? null;
}

async function expectReject(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected ${label} join to fail`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/expected .+ join to fail/.test(msg)) throw err;
    console.log(`  ${label}: ${msg}`);
  }
}

async function main() {
  if (!existsSync(STATE)) throw new Error("Run multi-agent up first");
  const state = JSON.parse(readFileSync(STATE, "utf8")) as {
    agents: Array<{ name: string; role: string; url: string; index: number }>;
  };
  const host = state.agents.find((a) => a.role === "host") ?? state.agents[0]!;

  console.log("→ fresh host session");
  const hostSession = await api<{ id: string }>(host.url, "/session", {
    method: "POST",
    body: JSON.stringify({ title: `chorus-hybrid-${Date.now()}` }),
  });

  await runCommand(host.url, hostSession.id, "chorus-stop", "");

  console.log("→ chorus-share requireApproval=true");
  const share = await runCommand(
    host.url,
    hostSession.id,
    "chorus-share",
    "edit requireApproval=true"
  );
  const blob = `${share.text}\n${share.toolOut}`;
  console.log(share.text.slice(0, 450));
  const token = extractToken(blob);
  if (!token) throw new Error("No token from share");
  console.log(`✓ token=${token.slice(0, 12)}…`);

  console.log("→ JoinClient connect (protocol)");
  const repoRemote = detectRepoRemote(REPO);
  console.log(`  repoRemote=${repoRemote ?? "(none)"}`);

  const emailGate = /email gate|allowedEmailDomain|@chorus\.test/i.test(blob);
  if (emailGate) {
    console.log("→ reject missing/wrong email");
    for (const [label, email] of [
      ["none", undefined],
      ["wrong", "eve@other.com"],
    ] as const) {
      const bad = new JoinClient(
        `ws://127.0.0.1:7742/ws`,
        token,
        "BadJoiner",
        repoRemote,
        email
      );
      await expectReject(bad.connect(), label);
    }
    console.log("✓ email gate rejected missing/wrong domain");
  }

  const jc = new JoinClient(
    `ws://127.0.0.1:7742/ws`,
    token,
    "HybridJoiner",
    repoRemote,
    emailGate ? "dev@chorus.test" : undefined
  );
  await jc.connect();
  const st = jc.getState();
  console.log(`  status=${st.status} userId=${st.userId}`);
  if (st.status !== "pending" || !st.userId) {
    throw new Error(`expected pending with userId, got status=${st.status}`);
  }
  console.log(`✓ pending userId=${st.userId}`);

  jc.sendInput("should-not-land-while-pending");
  await new Promise((r) => setTimeout(r, 200));

  console.log(`→ chorus-approve ${st.userId}`);
  const approved = await runCommand(host.url, hostSession.id, "chorus-approve", st.userId);
  console.log((approved.text || approved.toolOut).slice(0, 300));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && jc.getState().status !== "connected") {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`  after approve: status=${jc.getState().status}`);
  if (jc.getState().status !== "connected") {
    throw new Error("joiner never became connected after approve");
  }
  console.log("✓ joiner admitted");

  jc.disconnect();
  await runCommand(host.url, hostSession.id, "chorus-stop", "");
  console.log("\nHybrid security e2e passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
