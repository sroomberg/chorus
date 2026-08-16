import { describe, it, expect } from "vitest";
import { normalizeRepoRemote, repoRemotesMatch } from "../src/repo.js";
import { normalizeDisplayName } from "../src/protocol.js";

describe("normalizeRepoRemote", () => {
  it("equates SSH and HTTPS GitHub remotes", () => {
    expect(normalizeRepoRemote("git@github.com:acme/app.git")).toBe("github.com/acme/app");
    expect(normalizeRepoRemote("https://github.com/acme/app.git")).toBe("github.com/acme/app");
    expect(repoRemotesMatch("git@github.com:acme/app.git", "https://github.com/acme/app")).toBe(
      true
    );
  });

  it("handles ssh:// remotes", () => {
    expect(normalizeRepoRemote("ssh://git@gitlab.com/acme/app.git")).toBe("gitlab.com/acme/app");
  });
});

describe("normalizeDisplayName", () => {
  it("rejects empty names", () => {
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName(undefined)).toBeNull();
  });

  it("trims and accepts valid names", () => {
    expect(normalizeDisplayName("  Alice  ")).toBe("Alice");
  });
});
