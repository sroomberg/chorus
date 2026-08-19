import type { SessionEvent } from "@chorus/shared";

/** Injected host/AI transcript lines — never forward back over collab.input. */
export const MIRROR_LINE = /^\[(AI|Host)\]:/;

/** Collaborator (or already-labeled) user lines: `[name]: …`. */
export const LABELED_LINE = /^\[[^\]]+\]:\s/;

/** Slash commands and join-token payloads — not session prompts. */
const CHORUS_SLASH = /\/chorus-(?:share|join|leave|stop|status|chat|approve|deny|kick)\b/i;
const JOIN_NAMED_ARGS = /\btoken="[^"]+"\s+host="/;
const HOSTING_LOOP_ERROR = /currently hosting the session/i;

export type TextPartLike = {
  type: string;
  text?: string;
  synthetic?: boolean;
};

/** Non-synthetic text parts joined the same way chat.message used to inline. */
export function userTextFromParts(parts: TextPartLike[] | undefined): string {
  if (!parts?.length) return "";
  return parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text ?? "")
    .join("\n");
}

/** True for /chorus-* commands and join-token blobs that must not hit the host LLM. */
export function isChorusControlText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return CHORUS_SLASH.test(trimmed) || JOIN_NAMED_ARGS.test(trimmed);
}

/**
 * Host auto-fan-out should only publish the host's own unlabeled prompts.
 * Labeled collab lines are published by the collab.input handler so we do
 * not hold a global skip-flag across the host LLM turn.
 */
export function shouldFanOutHostUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (MIRROR_LINE.test(trimmed) || LABELED_LINE.test(trimmed)) return false;
  if (isChorusControlText(trimmed)) return false;
  return true;
}

/** Joiner user text that should be forwarded as collab.input. */
export function shouldForwardJoinerInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (MIRROR_LINE.test(trimmed)) return false;
  if (isChorusControlText(trimmed)) return false;
  return true;
}

/** Host assistant text that should be mirrored to joiners. */
export function shouldPublishAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (HOSTING_LOOP_ERROR.test(trimmed)) return false;
  if (isChorusControlText(trimmed)) return false;
  return true;
}

export function formatMirroredEvent(event: SessionEvent): string | null {
  const payload =
    typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  if (event.type === "user") {
    if (LABELED_LINE.test(payload)) return payload;
    return `[Host]: ${payload}`;
  }
  if (event.type === "assistant") return `[AI]: ${payload}`;
  return null;
}
