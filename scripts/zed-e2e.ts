#!/usr/bin/env bun
/**
 * Zed helper integration against a live chorus-relay:
 * join (pending) → approve → chat + collab.input → leave.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayServer } from "../packages/client/src/index.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = parseInt(process.env["CHORUS_ZED_E2E_PORT"] ?? "18743", 10);
const RUNTIME = join(REPO, ".multi-agent", "zed-e2e-runtime");

function helperBin(): string {
  if (process.env["CHORUS_ZED_HELPER_BIN"]) return process.env["CHORUS_ZED_HELPER_BIN"];
  for (const p of [
    join(REPO, "target/release/chorus-zed-helper"),
    join(REPO, "target/debug/chorus-zed-helper"),
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error("chorus-zed-helper not found; cargo build -p chorus-zed-helper --release");
}

function runHelper(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(helperBin(), args, {
      env: {
        ...process.env,
        CHORUS_ZED_RUNTIME_DIR: RUNTIME,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveP({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitUntil(fn: () => boolean, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const relay = new RelayServer(PORT);
  await relay.start();
  console.log(`✓ relay on :${PORT}`);

  const received: string[] = [];
  const pending: string[] = [];
  relay.setInputHandler(async (content) => {
    received.push(content);
  });
  relay.setUserPendingHandler((u) => pending.push(u.userId));
  relay.setSessionPolicy({ requireApproval: true });

  try {
    const token = (await relay.issueToken("zed-e2e", "edit")).token;
    const host = `127.0.0.1:${PORT}`;

    console.log("→ chorus-zed-helper join (pending)");
    const joined = await runHelper(["join", "--host", host, "--token", token, "--name", "ZedE2E"]);
    if (joined.code !== 0) {
      throw new Error(`join failed: ${joined.stderr || joined.stdout}`);
    }
    console.log(joined.stdout.slice(0, 400));
    await waitUntil(() => pending.length > 0, "host pending");

    const statusPending = await runHelper(["status"]);
    if (!/Pending|pending/i.test(`${statusPending.stdout}${statusPending.stderr}`)) {
      console.log(statusPending.stdout);
      // Snapshot JSON may serialize as "pending"
      if (!/"status"\s*:\s*"pending"/i.test(statusPending.stdout) && !/Pending/.test(statusPending.stdout)) {
        throw new Error(`expected pending status, got:\n${statusPending.stdout}`);
      }
    }
    console.log("✓ helper pending");

    console.log("→ approve");
    relay.approveUser(pending[0]!);
    await waitUntil(async () => {
      /* poll via helper */
      return true;
    }, "noop", 200);
    for (let i = 0; i < 40; i++) {
      const st = await runHelper(["status"]);
      if (/Connected|connected/i.test(st.stdout) && !/Pending/.test(st.stdout)) break;
      if (/"status"\s*:\s*"connected"/i.test(st.stdout)) break;
      await new Promise((r) => setTimeout(r, 100));
      if (i === 39) throw new Error(`never connected:\n${st.stdout}`);
    }
    console.log("✓ helper admitted");

    const prompt = await runHelper(["prompt", "from-zed-helper"]);
    if (prompt.code !== 0) throw new Error(`prompt failed: ${prompt.stderr || prompt.stdout}`);
    await waitUntil(() => received.includes("from-zed-helper"), "collab.input");
    console.log("✓ collab.input");

    const chat = await runHelper(["chat", "zed-side-channel"]);
    if (chat.code !== 0) throw new Error(`chat failed: ${chat.stderr || chat.stdout}`);
    console.log("✓ chat");

    await runHelper(["leave"]);
    console.log("\nZed helper e2e passed.");
  } finally {
    await runHelper(["leave"]).catch(() => {});
    relay.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
