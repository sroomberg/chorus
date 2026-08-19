import type { SessionEvent } from "@chorus/shared";
/** Injected host/AI transcript lines — never forward back over collab.input. */
export declare const MIRROR_LINE: RegExp;
/** Collaborator (or already-labeled) user lines: `[name]: …`. */
export declare const LABELED_LINE: RegExp;
export type TextPartLike = {
    type: string;
    text?: string;
    synthetic?: boolean;
};
/** Non-synthetic text parts joined the same way chat.message used to inline. */
export declare function userTextFromParts(parts: TextPartLike[] | undefined): string;
/** True for /chorus-* commands and join-token blobs that must not hit the host LLM. */
export declare function isChorusControlText(text: string): boolean;
/**
 * Host auto-fan-out should only publish the host's own unlabeled prompts.
 * Labeled collab lines are published by the collab.input handler so we do
 * not hold a global skip-flag across the host LLM turn.
 */
export declare function shouldFanOutHostUserText(text: string): boolean;
/** Joiner user text that should be forwarded as collab.input. */
export declare function shouldForwardJoinerInput(text: string): boolean;
/** Host assistant text that should be mirrored to joiners. */
export declare function shouldPublishAssistantText(text: string): boolean;
export declare function formatMirroredEvent(event: SessionEvent): string | null;
//# sourceMappingURL=transcript.d.ts.map