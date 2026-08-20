import type { ConnectedUser } from "@chorus/shared";

/** Short host-facing slot for a pending joiner (`1`, `2`, …). */
export interface QueueEntry {
  ref: string;
  user: ConnectedUser;
}

export interface QueueSnapshotItem {
  id: string;
  displayName: string;
  email?: string;
  role: ConnectedUser["role"];
  userId: string;
}

export type QueueResolveOk = {
  ok: true;
  userId: string;
  ref?: string;
  displayName?: string;
};

export type QueueResolveErr = {
  ok: false;
  error: string;
};

export type QueueResolveResult = QueueResolveOk | QueueResolveErr;

const LETTER = /^[A-Za-z]$/;
const DIGITS = /^\d+$/;

/** True when `id` is a queue slot (`1`, `02`, `A`) rather than a relay userId. */
export function isQueueSlot(id: string): boolean {
  return DIGITS.test(id) || LETTER.test(id);
}

/** Normalize a typed slot to the canonical numeric ref (`A`/`01` → `"1"`). */
export function slotToRef(id: string): string | undefined {
  if (DIGITS.test(id)) {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n < 1) return undefined;
    return String(n);
  }
  if (LETTER.test(id)) {
    return String(id.toUpperCase().charCodeAt(0) - 64);
  }
  return undefined;
}

export function formatQueueLine(entry: QueueEntry): string {
  const email = entry.user.email ? ` <${entry.user.email}>` : "";
  return `  ${entry.ref}  ${entry.user.displayName}${email}  ${entry.user.role}`;
}

/** First line of every live queue board — used to detect control text. */
export const JOIN_QUEUE_HEADER = "Chorus join queue";

/** Screen listing of pending joiners with short ids for approve/deny. */
export function formatPendingQueue(entries: QueueEntry[]): string {
  if (entries.length === 0) return `${JOIN_QUEUE_HEADER}\nNo pending joiners.`;
  const header = `Pending join queue (${entries.length}):`;
  const hint =
    "Approve with /chorus-approve <id> or deny with /chorus-deny <id> — id is the number (or letter A=1) next to the joiner.";
  return [JOIN_QUEUE_HEADER, header, ...entries.map(formatQueueLine), "", hint].join("\n");
}

/** Compact multi-line toast so the host can watch the queue change. */
export function formatPendingQueueToast(entries: QueueEntry[]): string {
  if (entries.length === 0) return "No pending joiners.";
  const lines = entries.map((entry) => {
    const email = entry.user.email ? ` <${entry.user.email}>` : "";
    return `${entry.ref}  ${entry.user.displayName}${email}  ${entry.user.role}`;
  });
  return [`Pending join queue (${entries.length}) — /chorus-approve <id>`, ...lines].join("\n");
}

/**
 * Host-side pending-join queue. Assigns stable short refs so the host can
 * approve/deny without pasting the relay userId.
 *
 * Refs are never reused while anyone is still waiting (avoids approving the
 * wrong person against a stale list). The counter resets when the queue empties.
 */
export class PendingQueue {
  private next = 1;
  private readonly byUserId = new Map<string, QueueEntry>();
  private readonly byRef = new Map<string, QueueEntry>();

  get size(): number {
    return this.byUserId.size;
  }

  enqueue(user: ConnectedUser): QueueEntry {
    const existing = this.byUserId.get(user.userId);
    if (existing) {
      existing.user = user;
      return existing;
    }
    const ref = String(this.next++);
    const entry: QueueEntry = { ref, user };
    this.byUserId.set(user.userId, entry);
    this.byRef.set(ref, entry);
    return entry;
  }

  remove(userId: string): QueueEntry | undefined {
    const entry = this.byUserId.get(userId);
    if (!entry) return undefined;
    this.byUserId.delete(userId);
    this.byRef.delete(entry.ref);
    if (this.byUserId.size === 0) this.next = 1;
    return entry;
  }

  getByUserId(userId: string): QueueEntry | undefined {
    return this.byUserId.get(userId);
  }

  getByRef(ref: string): QueueEntry | undefined {
    const normalized = slotToRef(ref.trim()) ?? ref.trim();
    return this.byRef.get(normalized);
  }

  list(): QueueEntry[] {
    return [...this.byUserId.values()].sort((a, b) => Number(a.ref) - Number(b.ref));
  }

  snapshot(): QueueSnapshotItem[] {
    return this.list().map((entry) => ({
      id: entry.ref,
      displayName: entry.user.displayName,
      ...(entry.user.email ? { email: entry.user.email } : {}),
      role: entry.user.role,
      userId: entry.user.userId,
    }));
  }

  clear(): void {
    this.byUserId.clear();
    this.byRef.clear();
    this.next = 1;
  }
}

/**
 * Resolve a chorus-approve / chorus-deny argument.
 *
 * - omitted / blank: the sole pending joiner, or an error if 0 or 2+
 * - `1` / `A`: queue slot
 * - anything else: treated as a relay userId (pass-through even if not queued yet)
 */
export function resolveQueueTarget(queue: PendingQueue, raw?: string): QueueResolveResult {
  const id = raw?.trim() ?? "";
  if (!id) {
    const entries = queue.list();
    if (entries.length === 1) {
      const only = entries[0]!;
      return {
        ok: true,
        userId: only.user.userId,
        ref: only.ref,
        displayName: only.user.displayName,
      };
    }
    if (entries.length === 0) {
      return { ok: false, error: "No pending joiners." };
    }
    return {
      ok: false,
      error: `Multiple pending joiners — pass a queue id.\n${formatPendingQueue(entries)}`,
    };
  }

  if (isQueueSlot(id)) {
    const entry = queue.getByRef(id);
    if (!entry) {
      return {
        ok: false,
        error: `No pending joiner at ${id}.\n${formatPendingQueue(queue.list())}`,
      };
    }
    return {
      ok: true,
      userId: entry.user.userId,
      ref: entry.ref,
      displayName: entry.user.displayName,
    };
  }

  const queued = queue.getByUserId(id);
  return {
    ok: true,
    userId: id,
    ref: queued?.ref,
    displayName: queued?.user.displayName,
  };
}
