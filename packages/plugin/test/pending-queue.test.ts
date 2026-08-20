import { describe, it, expect, beforeEach } from "vitest";
import type { ConnectedUser } from "@chorus/shared";
import {
  JOIN_QUEUE_HEADER,
  PendingQueue,
  formatPendingQueue,
  formatPendingQueueToast,
  isQueueSlot,
  resolveQueueTarget,
  slotToRef,
} from "../src/pending-queue.js";

function user(
  userId: string,
  displayName: string,
  extra: Partial<ConnectedUser> = {}
): ConnectedUser {
  return {
    userId,
    displayName,
    role: "edit",
    joinedAt: 1,
    status: "pending",
    ...extra,
  };
}

describe("slotToRef / isQueueSlot", () => {
  it("treats decimal numbers as slots", () => {
    expect(isQueueSlot("1")).toBe(true);
    expect(isQueueSlot("12")).toBe(true);
    expect(isQueueSlot("01")).toBe(true);
  });

  it("does not treat letters or relay userIds as slots", () => {
    expect(isQueueSlot("A")).toBe(false);
    expect(isQueueSlot("z")).toBe(false);
    expect(isQueueSlot("a1b2c3d4e5f67890")).toBe(false);
    expect(isQueueSlot("Alice")).toBe(false);
    expect(isQueueSlot("")).toBe(false);
  });

  it("normalizes 01 to 1 and rejects 0", () => {
    expect(slotToRef("1")).toBe("1");
    expect(slotToRef("01")).toBe("1");
    expect(slotToRef("A")).toBeUndefined();
    expect(slotToRef("0")).toBeUndefined();
  });
});

describe("PendingQueue", () => {
  let q: PendingQueue;
  beforeEach(() => {
    q = new PendingQueue();
  });

  it("assigns incrementing numeric refs", () => {
    expect(q.enqueue(user("u1", "Alice")).ref).toBe("1");
    expect(q.enqueue(user("u2", "Bob")).ref).toBe("2");
    expect(q.size).toBe(2);
  });

  it("keeps the same ref when the same userId re-enqueues", () => {
    q.enqueue(user("u1", "Alice"));
    const again = q.enqueue(user("u1", "Alice A.", { email: "a@x.com" }));
    expect(again.ref).toBe("1");
    expect(q.size).toBe(1);
    expect(again.user.email).toBe("a@x.com");
    expect(again.user.displayName).toBe("Alice A.");
  });

  it("does not reuse a ref while others are still pending", () => {
    q.enqueue(user("u1", "Alice"));
    q.enqueue(user("u2", "Bob"));
    q.remove("u1");
    expect(q.enqueue(user("u3", "Cara")).ref).toBe("3");
    expect(q.list().map((e) => e.ref)).toEqual(["2", "3"]);
  });

  it("resets numbering when the queue empties", () => {
    q.enqueue(user("u1", "Alice"));
    q.enqueue(user("u2", "Bob"));
    q.remove("u1");
    q.remove("u2");
    expect(q.enqueue(user("u3", "Cara")).ref).toBe("1");
  });

  it("snapshot lists id, name, role, userId", () => {
    q.enqueue(user("u1", "Alice", { email: "a@x.com", role: "view" }));
    expect(q.snapshot()).toEqual([
      { id: "1", displayName: "Alice", email: "a@x.com", role: "view", userId: "u1" },
    ]);
  });

  it("clear drops entries and resets the counter", () => {
    q.enqueue(user("u1", "Alice"));
    q.clear();
    expect(q.size).toBe(0);
    expect(q.enqueue(user("u2", "Bob")).ref).toBe("1");
  });
});

describe("formatPendingQueue", () => {
  it("prints a numbered list with joiner details and approve hint", () => {
    const q = new PendingQueue();
    q.enqueue(user("u1", "Alice", { email: "alice@acme.com" }));
    q.enqueue(user("u2", "Bob", { role: "view" }));
    const text = formatPendingQueue(q.list());
    expect(text.startsWith(JOIN_QUEUE_HEADER)).toBe(true);
    expect(text).toContain("Pending join queue (2):");
    expect(text).toContain("  1  Alice <alice@acme.com>  edit");
    expect(text).toContain("  2  Bob  view");
    expect(text).toContain("/chorus-approve <id>");
    expect(text).toContain("/chorus-deny <id>");
  });

  it("says when the queue is empty", () => {
    expect(formatPendingQueue([])).toBe(`${JOIN_QUEUE_HEADER}\nNo pending joiners.`);
  });

  it("formats a compact live toast listing every waiting joiner", () => {
    const q = new PendingQueue();
    q.enqueue(user("u1", "Alice", { email: "alice@acme.com" }));
    q.enqueue(user("u2", "Bob", { role: "view" }));
    expect(formatPendingQueueToast(q.list())).toBe(
      "Pending join queue (2) — /chorus-approve <id>\n1  Alice <alice@acme.com>  edit\n2  Bob  view"
    );
    expect(formatPendingQueueToast([])).toBe("No pending joiners.");
  });
});

describe("resolveQueueTarget", () => {
  let q: PendingQueue;
  beforeEach(() => {
    q = new PendingQueue();
    q.enqueue(user("aaaa1111bbbb2222", "Alice"));
    q.enqueue(user("cccc3333dddd4444", "Bob"));
  });

  it("resolves numeric slots", () => {
    expect(resolveQueueTarget(q, "1")).toMatchObject({
      ok: true,
      ref: "1",
      userId: "aaaa1111bbbb2222",
      displayName: "Alice",
    });
    expect(resolveQueueTarget(q, " 02 ")).toMatchObject({ ok: true, ref: "2" });
  });

  it("does not treat a letter as a slot", () => {
    expect(resolveQueueTarget(q, "B")).toEqual({
      ok: true,
      userId: "B",
      ref: undefined,
      displayName: undefined,
    });
  });

  it("resolves a full userId", () => {
    expect(resolveQueueTarget(q, "aaaa1111bbbb2222")).toMatchObject({
      ok: true,
      ref: "1",
      displayName: "Alice",
    });
  });

  it("passes through an unknown userId so the relay can still admit", () => {
    expect(resolveQueueTarget(q, "ffff9999eeee0000")).toEqual({
      ok: true,
      userId: "ffff9999eeee0000",
      ref: undefined,
      displayName: undefined,
    });
  });

  it("errors on a missing slot and reprints the queue", () => {
    const result = resolveQueueTarget(q, "9");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No pending joiner at 9");
    expect(result.error).toContain("  1  Alice");
  });

  it("requires an id when more than one joiner is waiting", () => {
    const result = resolveQueueTarget(q, "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Multiple pending joiners");
    expect(result.error).toContain("  2  Bob");
  });

  it("approves the only pending joiner when id is omitted", () => {
    q.remove("cccc3333dddd4444");
    expect(resolveQueueTarget(q, undefined)).toMatchObject({
      ok: true,
      ref: "1",
      userId: "aaaa1111bbbb2222",
    });
  });

  it("errors when the queue is empty and no id is given", () => {
    q.clear();
    expect(resolveQueueTarget(q)).toEqual({ ok: false, error: "No pending joiners." });
  });
});
