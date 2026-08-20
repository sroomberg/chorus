import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { JoinClient } from "../src/join/index.js";
import { RelayServer } from "../src/relay/index.js";

setDefaultTimeout(15_000);

const TEST_PORT = 17743;

describe("JoinClient (via Rust relay)", () => {
  let relay: RelayServer;

  beforeEach(async () => {
    relay = new RelayServer(TEST_PORT);
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  it("rejects connect with invalid token", async () => {
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, "bad-token", "Alice");
    await expect(jc.connect()).rejects.toThrow();
  });

  it("connects successfully with a valid token", async () => {
    const token = (await relay.issueToken("sess-1", "edit")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Alice");
    await jc.connect();
    expect(jc.getState().status).toBe("connected");
    jc.disconnect();
  });

  it("resolves as pending when approval is required", async () => {
    relay.setSessionPolicy({ requireApproval: true });
    const pendingIds: string[] = [];
    relay.setUserPendingHandler((u) => pendingIds.push(u.userId));

    const token = (await relay.issueToken("sess-1", "edit")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Bob");
    await jc.connect();
    expect(jc.getState().status).toBe("pending");

    await new Promise<void>((resolve) => {
      jc.setApprovedHandler(() => resolve());
      relay.approveUser(pendingIds[0] ?? jc.getState().userId!);
    });
    expect(jc.getState().status).toBe("connected");
    jc.disconnect();
  });

  it("receives session history on connect", async () => {
    relay.pushEvent({
      id: "e1",
      sessionId: "sess-1",
      type: "message.created",
      payload: "hello",
      timestamp: Date.now(),
    });

    const token = (await relay.issueToken("sess-1", "view")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Bob");
    const replayed: string[] = [];
    jc.setApprovedHandler(() => {
      replayed.push(...jc.getState().recentEvents.map((e) => e.id));
    });
    await jc.connect();
    expect(jc.getState().status).toBe("connected");
    expect(jc.getState().recentEvents).toHaveLength(1);
    expect(replayed).toContain("e1");
    jc.disconnect();
  });

  it("fires event handler for new events after connect", async () => {
    const token = (await relay.issueToken("sess-1", "edit")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Carol");
    await jc.connect();

    const received: string[] = [];
    jc.setEventHandler((ev) => received.push(ev.id));

    relay.pushEvent({
      id: "e-new",
      sessionId: "sess-1",
      type: "message.created",
      payload: "world",
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(received).toContain("e-new");
    jc.disconnect();
  });

  it("disconnect sets status to disconnected", async () => {
    const token = (await relay.issueToken("sess-1", "admin")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Host");
    await jc.connect();
    jc.disconnect();
    expect(jc.getState().status).toBe("disconnected");
  });

  it("sendInput is a no-op when not connected", () => {
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, "tok", "X");
    expect(() => jc.sendInput("hello")).not.toThrow();
  });

  it("can send collab input when connected as edit role", async () => {
    const received: string[] = [];
    relay.setInputHandler(async (content) => {
      received.push(content);
    });

    const token = (await relay.issueToken("sess-1", "edit")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Dev");
    await jc.connect();

    jc.sendInput("refactor this function");
    await new Promise((r) => setTimeout(r, 80));
    expect(received).toContain("refactor this function");
    jc.disconnect();
  });

  it("blocks collab input while pending", async () => {
    relay.setSessionPolicy({ requireApproval: true });
    const received: string[] = [];
    relay.setInputHandler(async (content) => {
      received.push(content);
    });

    const token = (await relay.issueToken("sess-1", "edit")).token;
    const jc = new JoinClient(`ws://localhost:${TEST_PORT}/ws`, token, "Dev");
    await jc.connect();
    expect(jc.getState().status).toBe("pending");
    jc.sendInput("should not land");
    await new Promise((r) => setTimeout(r, 80));
    expect(received).toHaveLength(0);
    jc.disconnect();
  });
});
