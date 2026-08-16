import type { SessionEvent } from "@chorus/shared";
/** Format a shared session event for the Chorus panel / notifications. */
export declare function formatSessionLine(event: SessionEvent): string | null;
export declare function newEventId(): string;
