import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RelayServer } from "../src/index.js";
import type { ServerMessage } from "@chorus/shared";
import { encodeMessage, decodeServerMessage } from "@chorus/shared";

const TEST_PORT = 17742;

async function connectWs(
  token: string,
  displayName = "Alice"
): Promise<{ ws: WebSocket; messages: ServerMessage[]; close: () => void }> {
  const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
  const messages: ServerMessage[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(encodeMessage({ type: "auth", token, displayName }));
      resolve();
    };
    ws.onerror = reject;
  });

  ws.onmessage = (ev) => {
    messages.push(decodeServerMessage(ev.data as string));
  };

  return { ws, messages, close: () => ws.close() };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

describe("RelayServer (Rust)", () => {
  let relay: RelayServer;

  beforeEach(async () => {
    relay = new RelayServer(TEST_PORT);
    await relay.start();
  });

  afterEach(() => {
    relay.stop();
  });

  it("rejects connections with invalid token", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(encodeMessage({ type: "auth", token: "bad-token", displayName: "X" }));

    const closed = await new Promise<CloseEvent>((r) => (ws.onclose = r));
    expect(closed.code).toBe(4001);
  });

  it("rejects connections without a display name", async () => {
    const token = (await relay.issueToken("sess-1")).token;
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(JSON.stringify({ type: "auth", token, displayName: "   " }));

    const closed = await new Promise<CloseEvent>((r) => (ws.onclose = r));
    expect(closed.code).toBe(4002);
  });

  it("accepts a valid token and sends history + user list", async () => {
    const token = (await relay.issueToken("sess-1")).token;
    const { messages, close } = await connectWs(token, "Alice");

    await waitFor(() => (messages.find((m) => m.type === "user.list") ? true : undefined));

    expect(messages.some((m) => m.type === "session.history")).toBe(true);
    expect(messages.some((m) => m.type === "user.list")).toBe(true);
    close();
  });

  it("holds joiners in pending until host approves", async () => {
    relay.setSessionPolicy({ requireApproval: true });
    const pending: string[] = [];
    relay.setUserPendingHandler((u) => pending.push(u.userId));

    const token = (await relay.issueToken("sess-1")).token;
    const { messages, close } = await connectWs(token, "Pat");

    await waitFor(() => (messages.find((m) => m.type === "auth.pending") ? true : undefined));
    expect(messages.some((m) => m.type === "session.history")).toBe(false);
    await waitFor(() => (pending.length > 0 ? true : undefined));

    relay.approveUser(pending[0]!);
    await waitFor(() => (messages.find((m) => m.type === "session.history") ? true : undefined));
    close();
  });

  it("rejects joiners with mismatched repo remote when policy binds a repo", async () => {
    relay.setSessionPolicy({
      requireApproval: false,
      repoRemote: "https://github.com/acme/app.git",
    });
    const token = (await relay.issueToken("sess-1")).token;
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(
      encodeMessage({
        type: "auth",
        token,
        displayName: "Eve",
        repoRemote: "https://github.com/other/repo.git",
      })
    );

    const closed = await new Promise<CloseEvent>((r) => (ws.onclose = r));
    expect(closed.code).toBe(4004);
  });

  it("accepts matching SSH/HTTPS remotes for the repo gate", async () => {
    relay.setSessionPolicy({
      requireApproval: false,
      repoRemote: "https://github.com/acme/app.git",
    });
    const token = (await relay.issueToken("sess-1")).token;
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          encodeMessage({
            type: "auth",
            token,
            displayName: "Dev",
            repoRemote: "git@github.com:acme/app.git",
          })
        );
        resolve();
      };
      ws.onerror = reject;
    });
    ws.onmessage = (ev) => messages.push(decodeServerMessage(ev.data as string));
    await waitFor(() => (messages.find((m) => m.type === "user.list") ? true : undefined));
    expect(messages.some((m) => m.type === "session.history")).toBe(true);
    ws.close();
  });

  it("broadcasts session events to all connected clients", async () => {
    const t1 = (await relay.issueToken("sess-1")).token;
    const t2 = (await relay.issueToken("sess-1")).token;
    const c1 = await connectWs(t1, "One");
    const c2 = await connectWs(t2, "Two");

    await waitFor(() => (c1.messages.find((m) => m.type === "user.list") ? true : undefined));
    await waitFor(() => (c2.messages.find((m) => m.type === "user.list") ? true : undefined));

    relay.pushEvent({
      id: "e1",
      sessionId: "sess-1",
      type: "message.created",
      payload: "hello",
      timestamp: Date.now(),
    });

    await waitFor(() =>
      c1.messages.find((m) => m.type === "session.event") ? true : undefined
    );
    await waitFor(() =>
      c2.messages.find((m) => m.type === "session.event") ? true : undefined
    );

    expect(c1.messages.some((m) => m.type === "session.event")).toBe(true);
    expect(c2.messages.some((m) => m.type === "session.event")).toBe(true);

    c1.close();
    c2.close();
  });

  it("calls input handler when collaborator sends collab.input", async () => {
    const received: string[] = [];
    relay.setInputHandler(async (content) => {
      received.push(content);
    });

    const token = (await relay.issueToken("sess-1", "edit")).token;
    const { ws, messages, close } = await connectWs(token, "Dev");

    await waitFor(() => (messages.find((m) => m.type === "user.list") ? true : undefined));

    ws.send(encodeMessage({ type: "collab.input", content: "refactor this" }));
    await waitFor(() => (received.length > 0 ? true : undefined));

    expect(received[0]).toBe("refactor this");
    close();
  });
});
