import { describe, it, expect } from "vitest";
import {
  formatMirroredEvent,
  shouldFanOutHostUserText,
  shouldForwardJoinerInput,
  shouldPublishAssistantText,
  userTextFromParts,
} from "../src/transcript.js";
import type { SessionEvent } from "@chorus/shared";

function event(type: string, payload: unknown): SessionEvent {
  return {
    id: "e1",
    sessionId: "s1",
    type,
    payload,
    timestamp: 1,
  };
}

describe("userTextFromParts", () => {
  it("joins non-synthetic text parts", () => {
    expect(
      userTextFromParts([
        { type: "text", text: "hello" },
        { type: "text", text: "world", synthetic: true },
        { type: "step-start" },
      ])
    ).toBe("hello");
  });

  it("returns empty for missing parts", () => {
    expect(userTextFromParts(undefined)).toBe("");
    expect(userTextFromParts([])).toBe("");
  });
});

describe("shouldFanOutHostUserText", () => {
  it("publishes unlabeled host prompts", () => {
    expect(shouldFanOutHostUserText("hi how are you")).toBe(true);
  });

  it("skips collaborator-labeled lines so chat.message does not wait on the LLM flag", () => {
    expect(shouldFanOutHostUserText("[steve]: hello world")).toBe(false);
  });

  it("skips mirrored transcript lines", () => {
    expect(shouldFanOutHostUserText("[Host]: already mirrored")).toBe(false);
    expect(shouldFanOutHostUserText("[AI]: reply")).toBe(false);
  });

  it("skips empty text", () => {
    expect(shouldFanOutHostUserText("  \n")).toBe(false);
  });

  it("skips chorus slash commands and join-token payloads", () => {
    expect(
      shouldFanOutHostUserText(
        '/chorus-join token="abc" host="192.168.1.5:7742" name="Ada"'
      )
    ).toBe(false);
    expect(shouldFanOutHostUserText('token="abc12345" host="h:7742"')).toBe(false);
  });
});

describe("shouldForwardJoinerInput", () => {
  it("forwards normal joiner prompts", () => {
    expect(shouldForwardJoinerInput("please refactor this")).toBe(true);
  });

  it("does not forward join commands to the host", () => {
    expect(
      shouldForwardJoinerInput(
        '/chorus-join token="abc" host="host.docker.internal:7742" name="Ada"'
      )
    ).toBe(false);
  });
});

describe("shouldPublishAssistantText", () => {
  it("publishes normal assistant replies", () => {
    expect(shouldPublishAssistantText("Sure, here is a plan.")).toBe(true);
  });

  it("drops the host/join feedback-loop error", () => {
    expect(
      shouldPublishAssistantText(
        "**Failed to join** — this agent is currently hosting the session."
      )
    ).toBe(false);
  });
});

describe("formatMirroredEvent", () => {
  it("labels unlabeled host user events", () => {
    expect(formatMirroredEvent(event("user", "hi how are you"))).toBe("[Host]: hi how are you");
  });

  it("keeps collaborator labels", () => {
    expect(formatMirroredEvent(event("user", "[steve]: hello world"))).toBe("[steve]: hello world");
  });

  it("labels assistant events", () => {
    expect(formatMirroredEvent(event("assistant", "ok"))).toBe("[AI]: ok");
  });

  it("ignores other event types", () => {
    expect(formatMirroredEvent(event("message.created", "x"))).toBeNull();
  });
});
