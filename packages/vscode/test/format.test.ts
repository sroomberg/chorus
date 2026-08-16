import { describe, expect, it } from "bun:test";
import { formatSessionLine } from "../src/format.ts";

describe("formatSessionLine", () => {
  it("labels plain user events as Host", () => {
    expect(
      formatSessionLine({
        id: "1",
        sessionId: "s",
        type: "user",
        payload: "hello",
        timestamp: 1,
      })
    ).toBe("[Host]: hello");
  });

  it("keeps already-labeled collaborator lines", () => {
    expect(
      formatSessionLine({
        id: "1",
        sessionId: "s",
        type: "user",
        payload: "[Ada]: refactor",
        timestamp: 1,
      })
    ).toBe("[Ada]: refactor");
  });

  it("labels assistant events as AI", () => {
    expect(
      formatSessionLine({
        id: "1",
        sessionId: "s",
        type: "assistant",
        payload: "sure",
        timestamp: 1,
      })
    ).toBe("[AI]: sure");
  });
});
