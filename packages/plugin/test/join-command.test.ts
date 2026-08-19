import { describe, it, expect } from "vitest";
import {
  JOIN_NAME_PLACEHOLDER,
  JOIN_EMAIL_PLACEHOLDER,
  formatJoinCommand,
} from "../src/join-command.js";

describe("formatJoinCommand", () => {
  it("includes required name and optional email slot", () => {
    expect(formatJoinCommand("tok-test", "192.168.1.5:7742")).toBe(
      `/chorus-join token="tok-test" host="192.168.1.5:7742" name="${JOIN_NAME_PLACEHOLDER}" [email="${JOIN_EMAIL_PLACEHOLDER}"]`
    );
  });

  it("requires a company email when the host has a domain gate", () => {
    expect(
      formatJoinCommand("tok-test", "192.168.1.5:7742", { allowedEmailDomain: "acme.com" })
    ).toBe(
      `/chorus-join token="tok-test" host="192.168.1.5:7742" name="${JOIN_NAME_PLACEHOLDER}" email="you@acme.com"`
    );
  });
});
