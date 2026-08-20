const LETTER = /^[A-Za-z]$/;
const DIGITS = /^\d+$/;
/** True when `id` is a queue slot (`1`, `02`, `A`) rather than a relay userId. */
export function isQueueSlot(id) {
    return DIGITS.test(id) || LETTER.test(id);
}
/** Normalize a typed slot to the canonical numeric ref (`A`/`01` → `"1"`). */
export function slotToRef(id) {
    if (DIGITS.test(id)) {
        const n = Number.parseInt(id, 10);
        if (!Number.isFinite(n) || n < 1)
            return undefined;
        return String(n);
    }
    if (LETTER.test(id)) {
        return String(id.toUpperCase().charCodeAt(0) - 64);
    }
    return undefined;
}
export function formatQueueLine(entry) {
    const email = entry.user.email ? ` <${entry.user.email}>` : "";
    return `  ${entry.ref}  ${entry.user.displayName}${email}  ${entry.user.role}`;
}
/** Screen listing of pending joiners with short ids for approve/deny. */
export function formatPendingQueue(entries) {
    if (entries.length === 0)
        return "No pending joiners.";
    const header = `Pending join queue (${entries.length}):`;
    const hint = "Approve with /chorus-approve <id> or deny with /chorus-deny <id> — id is the number (or letter A=1) next to the joiner.";
    return [header, ...entries.map(formatQueueLine), "", hint].join("\n");
}
/**
 * Host-side pending-join queue. Assigns stable short refs so the host can
 * approve/deny without pasting the relay userId.
 *
 * Refs are never reused while anyone is still waiting (avoids approving the
 * wrong person against a stale list). The counter resets when the queue empties.
 */
export class PendingQueue {
    next = 1;
    byUserId = new Map();
    byRef = new Map();
    get size() {
        return this.byUserId.size;
    }
    enqueue(user) {
        const existing = this.byUserId.get(user.userId);
        if (existing) {
            existing.user = user;
            return existing;
        }
        const ref = String(this.next++);
        const entry = { ref, user };
        this.byUserId.set(user.userId, entry);
        this.byRef.set(ref, entry);
        return entry;
    }
    remove(userId) {
        const entry = this.byUserId.get(userId);
        if (!entry)
            return undefined;
        this.byUserId.delete(userId);
        this.byRef.delete(entry.ref);
        if (this.byUserId.size === 0)
            this.next = 1;
        return entry;
    }
    getByUserId(userId) {
        return this.byUserId.get(userId);
    }
    getByRef(ref) {
        const normalized = slotToRef(ref.trim()) ?? ref.trim();
        return this.byRef.get(normalized);
    }
    list() {
        return [...this.byUserId.values()].sort((a, b) => Number(a.ref) - Number(b.ref));
    }
    snapshot() {
        return this.list().map((entry) => ({
            id: entry.ref,
            displayName: entry.user.displayName,
            ...(entry.user.email ? { email: entry.user.email } : {}),
            role: entry.user.role,
            userId: entry.user.userId,
        }));
    }
    clear() {
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
export function resolveQueueTarget(queue, raw) {
    const id = raw?.trim() ?? "";
    if (!id) {
        const entries = queue.list();
        if (entries.length === 1) {
            const only = entries[0];
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
//# sourceMappingURL=pending-queue.js.map