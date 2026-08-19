import { describe, expect, it } from "bun:test";
import { escapeHtml } from "../src/ui.ts";

describe("escapeHtml", () => {
  it("escapes quotes so insert buttons cannot break out of attributes", () => {
    expect(escapeHtml(`x" onclick="alert(1)`)).toBe("x&quot; onclick=&quot;alert(1)");
  });
});
