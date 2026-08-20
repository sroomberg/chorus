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
/** True when `id` is a queue slot (`1`, `02`) rather than a relay userId. */
export declare function isQueueSlot(id: string): boolean;
/** Normalize a typed slot to the canonical numeric ref (`01` → `"1"`). */
export declare function slotToRef(id: string): string | undefined;
export declare function formatQueueLine(entry: QueueEntry): string;
/** First line of every live queue board — used to detect control text. */
export declare const JOIN_QUEUE_HEADER = "Chorus join queue";
/** Screen listing of pending joiners with short ids for approve/deny. */
export declare function formatPendingQueue(entries: QueueEntry[]): string;
/** Compact multi-line toast so the host can watch the queue change. */
export declare function formatPendingQueueToast(entries: QueueEntry[]): string;
/**
 * Host-side pending-join queue. Assigns stable short refs so the host can
 * approve/deny without pasting the relay userId.
 *
 * Refs are never reused while anyone is still waiting (avoids approving the
 * wrong person against a stale list). The counter resets when the queue empties.
 */
export declare class PendingQueue {
    private next;
    private readonly byUserId;
    private readonly byRef;
    get size(): number;
    enqueue(user: ConnectedUser): QueueEntry;
    remove(userId: string): QueueEntry | undefined;
    getByUserId(userId: string): QueueEntry | undefined;
    getByRef(ref: string): QueueEntry | undefined;
    list(): QueueEntry[];
    snapshot(): QueueSnapshotItem[];
    clear(): void;
}
/**
 * Resolve a chorus-approve / chorus-deny argument.
 *
 * - omitted / blank: the sole pending joiner, or an error if 0 or 2+
 * - `1` / `2`: queue slot
 * - anything else: treated as a relay userId (pass-through even if not queued yet)
 */
export declare function resolveQueueTarget(queue: PendingQueue, raw?: string): QueueResolveResult;
//# sourceMappingURL=pending-queue.d.ts.map