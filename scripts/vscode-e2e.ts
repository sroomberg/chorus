#!/usr/bin/env bun
/**
 * VS Code adapter integration: same JoinClient + RelayServer path the
 * extension uses (share policy, pending admit, email gate, collab.input).
 * Does not require a VS Code GUI.
 */
import { JoinClient, RelayServer } from "../packages/client/src/index.ts";

const PORT = parseInt(process.env["CHORUS_VSCODE_E2E_PORT"] ?? "18742", 10);

async function expectReject(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected ${label} to fail`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/expected .+ to fail/.test(msg)) throw err;
    console.log(`  ${label}: ${msg}`);
  }
}

async function waitUntil(fn: () => boolean, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const relay = new RelayServer(PORT);
  await relay.start();
  console.log(`✓ relay on :${PORT}`);

  try {
    relay.setSessionPolicy({
      requireApproval: true,
      allowedEmailDomain: "chorus.test",
    });

    const token = (await relay.issueToken("vscode-e2e", "edit")).token;

    console.log("→ reject wrong email");
    const bad = new JoinClient(`ws://127.0.0.1:${PORT}/ws`, token, "Eve", undefined, "eve@other.com");
    await expectReject(bad.connect(), "wrong-email");

    const pendingIds: string[] = [];
    relay.setUserPendingHandler((u) => pendingIds.push(u.userId));
    const received: string[] = [];
    relay.setInputHandler(async (content) => {
      received.push(content);
    });

    console.log("→ join with matching email (pending)");
    const jc = new JoinClient(
      `ws://127.0.0.1:${PORT}/ws`,
      token,
      "VscodeJoiner",
      undefined,
      "dev@chorus.test"
    );
    await jc.connect();
    if (jc.getState().status !== "pending") {
      throw new Error(`expected pending, got ${jc.getState().status}`);
    }
    await waitUntil(() => pendingIds.length > 0, "host saw pending");
    console.log(`✓ pending userId=${pendingIds[0]}`);

    jc.sendInput("should-not-land");
    await new Promise((r) => setTimeout(r, 120));
    if (received.length !== 0) throw new Error("collab.input leaked while pending");

    console.log("→ approve");
    relay.approveUser(pendingIds[0]!);
    await waitUntil(() => jc.getState().status === "connected", "joiner admitted");
    console.log("✓ admitted");

    jc.sendInput("from-vscode-adapter");
    await waitUntil(() => received.includes("from-vscode-adapter"), "collab.input");
    console.log("✓ collab.input after approve");

    jc.disconnect();
    console.log("\nVS Code adapter e2e passed.");
  } finally {
    relay.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
