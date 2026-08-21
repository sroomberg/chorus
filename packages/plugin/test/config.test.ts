import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseChorusConfig,
  mergeConfigPartial,
  loadChorusConfig,
  resolveRequireApproval,
  resolveDefaultRole,
  resolveAllowedEmailDomain,
  emailDomainGateEnabled,
  DEFAULT_CHORUS_CONFIG,
} from "../src/config/index.js";

describe("parseChorusConfig", () => {
  it("applies defaults for an empty object", () => {
    const cfg = parseChorusConfig({});
    expect(cfg.security.requireApproval).toBe(false);
    expect(cfg.security.allowSkipApproval).toBe(true);
    expect(cfg.security.requireRepoMatch).toBe(false);
    expect(cfg.security.requireEmailDomainMatch).toBe(false);
    expect(cfg.security.additionalRepoRemotePrefixes).toEqual([]);
    expect(cfg.security.repoRemoteRewrites).toEqual([]);
    expect(cfg.security.defaultRole).toBe("edit");
  });

  it("accepts enterprise security locks", () => {
    const cfg = parseChorusConfig({
      org: { name: "Acme" },
      security: {
        requireApproval: true,
        allowSkipApproval: false,
        requireRepoMatch: true,
        requireEmailDomainMatch: true,
        allowedEmailDomain: "acme.com",
        additionalRepoRemotePrefixes: ["git://"],
        repoRemoteRewrites: [{ from: "github.acme.com", to: "github.com" }],
        defaultRole: "view",
        tokenTtlMs: 3600000,
      },
      relay: {
        bind: "10.0.0.5",
        allowOpenBind: false,
        allowedCidrs: ["10.0.0.0/8", "100.64.0.0/10"],
        allowLoopback: true,
      },
    });
    expect(cfg.org.name).toBe("Acme");
    expect(cfg.security.allowSkipApproval).toBe(false);
    expect(cfg.security.requireRepoMatch).toBe(true);
    expect(cfg.security.requireEmailDomainMatch).toBe(true);
    expect(cfg.security.allowedEmailDomain).toBe("acme.com");
    expect(cfg.security.additionalRepoRemotePrefixes).toEqual(["git://"]);
    expect(cfg.security.repoRemoteRewrites).toEqual([
      { from: "github.acme.com", to: "github.com" },
    ]);
    expect(cfg.security.defaultRole).toBe("view");
    expect(cfg.security.tokenTtlMs).toBe(3600000);
    expect(cfg.relay.bind).toBe("10.0.0.5");
    expect(cfg.relay.allowOpenBind).toBe(false);
    expect(cfg.relay.allowedCidrs).toEqual(["10.0.0.0/8", "100.64.0.0/10"]);
    expect(cfg.relay.allowLoopback).toBe(true);
  });

  it("defaults relay network knobs to LAN-friendly", () => {
    const cfg = parseChorusConfig({});
    expect(cfg.relay.allowedCidrs).toEqual([]);
    expect(cfg.relay.deniedCidrs).toEqual([]);
    expect(cfg.relay.allowedPorts).toEqual([]);
    expect(cfg.relay.allowOpenBind).toBe(true);
    expect(cfg.relay.allowLoopback).toBe(true);
    expect(cfg.relay.bind).toBeUndefined();
  });

  it("accepts deny CIDRs and source-port allowlist", () => {
    const cfg = parseChorusConfig({
      relay: {
        deniedCidrs: ["203.0.113.0/24"],
        allowedPorts: [18201, 18202],
      },
    });
    expect(cfg.relay.deniedCidrs).toEqual(["203.0.113.0/24"]);
    expect(cfg.relay.allowedPorts).toEqual([18201, 18202]);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseChorusConfig({ nope: true } as Record<string, unknown>)).toThrow();
  });
});

describe("mergeConfigPartial", () => {
  it("deep-merges nested objects", () => {
    const merged = mergeConfigPartial(
      { security: { requireApproval: true, defaultRole: "edit" } },
      { security: { allowSkipApproval: false }, org: { name: "Acme" } }
    );
    expect(merged).toEqual({
      security: { requireApproval: true, defaultRole: "edit", allowSkipApproval: false },
      org: { name: "Acme" },
    });
  });
});

describe("resolveRequireApproval / resolveDefaultRole", () => {
  it("uses config default when tool arg omitted", () => {
    expect(resolveRequireApproval(DEFAULT_CHORUS_CONFIG.security, undefined)).toBe(false);
    expect(resolveDefaultRole(DEFAULT_CHORUS_CONFIG.security, undefined)).toBe("edit");
  });

  it("allows tool override when allowSkipApproval is true", () => {
    const security = { ...DEFAULT_CHORUS_CONFIG.security, allowSkipApproval: true };
    expect(resolveRequireApproval(security, false)).toBe(false);
  });

  it("ignores tool override when allowSkipApproval is false", () => {
    const security = {
      ...DEFAULT_CHORUS_CONFIG.security,
      requireApproval: true,
      allowSkipApproval: false,
    };
    expect(resolveRequireApproval(security, false)).toBe(true);
  });
});

describe("resolveAllowedEmailDomain / emailDomainGateEnabled", () => {
  it("normalizes configured domains", () => {
    expect(
      resolveAllowedEmailDomain({
        ...DEFAULT_CHORUS_CONFIG.security,
        allowedEmailDomain: "@Acme.COM",
      })
    ).toBe("acme.com");
  });

  it("treats email gate as enabled when requireEmailDomainMatch is on", () => {
    expect(
      emailDomainGateEnabled({
        ...DEFAULT_CHORUS_CONFIG.security,
        requireEmailDomainMatch: true,
        allowedEmailDomain: "acme.com",
      })
    ).toBe(true);
  });

  it("treats email gate as enabled when only allowedEmailDomain is set", () => {
    expect(
      emailDomainGateEnabled({
        ...DEFAULT_CHORUS_CONFIG.security,
        allowedEmailDomain: "acme.com",
      })
    ).toBe(true);
  });
});

describe("loadChorusConfig", () => {
  const prevConfig = process.env["CHORUS_CONFIG"];
  const prevSystem = process.env["CHORUS_SYSTEM_CONFIG"];
  const prevUser = process.env["CHORUS_USER_CONFIG"];
  const prevPort = process.env["CHORUS_PORT"];
  const prevBind = process.env["CHORUS_BIND"];
  const prevCidrs = process.env["CHORUS_ALLOWED_CIDRS"];
  const prevOpenBind = process.env["CHORUS_ALLOW_OPEN_BIND"];
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `chorus-config-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    delete process.env["CHORUS_CONFIG"];
    delete process.env["CHORUS_PORT"];
    delete process.env["CHORUS_BIND"];
    delete process.env["CHORUS_ALLOWED_CIDRS"];
    delete process.env["CHORUS_ALLOW_OPEN_BIND"];
    // Isolate from real machine /etc and ~/.config during unit tests.
    process.env["CHORUS_SYSTEM_CONFIG"] = join(root, "missing-system.json");
    process.env["CHORUS_USER_CONFIG"] = join(root, "missing-user.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env["CHORUS_CONFIG"];
    else process.env["CHORUS_CONFIG"] = prevConfig;
    if (prevSystem === undefined) delete process.env["CHORUS_SYSTEM_CONFIG"];
    else process.env["CHORUS_SYSTEM_CONFIG"] = prevSystem;
    if (prevUser === undefined) delete process.env["CHORUS_USER_CONFIG"];
    else process.env["CHORUS_USER_CONFIG"] = prevUser;
    if (prevPort === undefined) delete process.env["CHORUS_PORT"];
    else process.env["CHORUS_PORT"] = prevPort;
    if (prevBind === undefined) delete process.env["CHORUS_BIND"];
    else process.env["CHORUS_BIND"] = prevBind;
    if (prevCidrs === undefined) delete process.env["CHORUS_ALLOWED_CIDRS"];
    else process.env["CHORUS_ALLOWED_CIDRS"] = prevCidrs;
    if (prevOpenBind === undefined) delete process.env["CHORUS_ALLOW_OPEN_BIND"];
    else process.env["CHORUS_ALLOW_OPEN_BIND"] = prevOpenBind;
  });

  it("loads project chorus.json", () => {
    writeFileSync(
      join(root, "chorus.json"),
      JSON.stringify({
        org: { name: "Project Org" },
        security: { requireApproval: false },
      })
    );
    const loaded = loadChorusConfig(root);
    expect(loaded.config.org.name).toBe("Project Org");
    expect(loaded.config.security.requireApproval).toBe(false);
    expect(loaded.sources.some((s) => s.kind === "project")).toBe(true);
  });

  it("prefers CHORUS_CONFIG over project file", () => {
    writeFileSync(
      join(root, "chorus.json"),
      JSON.stringify({ security: { requireApproval: false } })
    );
    const explicit = join(root, "enterprise.json");
    writeFileSync(
      explicit,
      JSON.stringify({
        security: { requireApproval: true, allowSkipApproval: false },
        org: { name: "Enterprise" },
      })
    );
    process.env["CHORUS_CONFIG"] = explicit;
    const loaded = loadChorusConfig(root);
    expect(loaded.config.org.name).toBe("Enterprise");
    expect(loaded.config.security.allowSkipApproval).toBe(false);
    expect(loaded.config.security.requireApproval).toBe(true);
  });

  it("applies CHORUS_PORT env over file relay.port", () => {
    writeFileSync(join(root, "chorus.json"), JSON.stringify({ relay: { port: 1111 } }));
    process.env["CHORUS_PORT"] = "2222";
    const loaded = loadChorusConfig(root);
    expect(loaded.config.relay.port).toBe(2222);
    expect(loaded.sources.some((s) => s.kind === "env")).toBe(true);
  });

  it("applies network allowlist env overrides", () => {
    writeFileSync(join(root, "chorus.json"), JSON.stringify({ relay: { port: 7742 } }));
    process.env["CHORUS_BIND"] = "10.0.0.5";
    process.env["CHORUS_ALLOWED_CIDRS"] = "10.0.0.0/8, 100.64.0.0/10";
    process.env["CHORUS_ALLOW_OPEN_BIND"] = "false";
    const loaded = loadChorusConfig(root);
    expect(loaded.config.relay.bind).toBe("10.0.0.5");
    expect(loaded.config.relay.allowedCidrs).toEqual(["10.0.0.0/8", "100.64.0.0/10"]);
    expect(loaded.config.relay.allowOpenBind).toBe(false);
  });

  it("loads .chorus/config.json when chorus.json is absent", () => {
    mkdirSync(join(root, ".chorus"), { recursive: true });
    writeFileSync(
      join(root, ".chorus", "config.json"),
      JSON.stringify({ org: { name: "Dot Chorus" } })
    );
    const loaded = loadChorusConfig(root);
    expect(loaded.config.org.name).toBe("Dot Chorus");
  });
});
