import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chorusConfigSchema,
  DEFAULT_CHORUS_CONFIG,
  mergeConfigPartial,
  type ChorusConfig,
  type ChorusConfigFile,
} from "./schema.js";

export type ConfigSource =
  | "defaults"
  | "system"
  | "user"
  | "project"
  | "CHORUS_CONFIG"
  | "env";

export interface LoadedChorusConfig {
  config: ChorusConfig;
  /** Absolute paths that contributed (missing files omitted). */
  sources: Array<{ kind: ConfigSource; path?: string }>;
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `Invalid Chorus config at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function asPartialObject(value: unknown, path: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Chorus config at ${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Candidate paths for a project working directory (first existing wins as "project"). */
export function projectConfigPaths(projectDir: string): string[] {
  return [join(projectDir, "chorus.json"), join(projectDir, ".chorus", "config.json")];
}

export function userConfigPath(): string {
  return process.env["CHORUS_USER_CONFIG"] ?? join(homedir(), ".config", "chorus", "config.json");
}

export function systemConfigPath(): string {
  return process.env["CHORUS_SYSTEM_CONFIG"] ?? "/etc/chorus/config.json";
}

/**
 * Load and merge Chorus configuration.
 *
 * Precedence (later wins for overlapping keys):
 *   1. built-in defaults
 *   2. system / org file (`/etc/chorus/config.json` or CHORUS_SYSTEM_CONFIG)
 *   3. user file (`~/.config/chorus/config.json`)
 *   4. project file (`chorus.json` or `.chorus/config.json` under projectDir)
 *   5. explicit CHORUS_CONFIG path
 *   6. selected environment overrides (relay port/bind/allowlist, public host, backup)
 */
export function loadChorusConfig(projectDir?: string): LoadedChorusConfig {
  const sources: LoadedChorusConfig["sources"] = [{ kind: "defaults" }];
  let merged: Record<string, unknown> = {};

  const layers: Array<{ kind: ConfigSource; path: string }> = [
    { kind: "system", path: systemConfigPath() },
    { kind: "user", path: userConfigPath() },
  ];

  if (projectDir) {
    for (const path of projectConfigPaths(projectDir)) {
      if (existsSync(path)) {
        layers.push({ kind: "project", path });
        break;
      }
    }
  }

  const explicit = process.env["CHORUS_CONFIG"];
  if (explicit) {
    layers.push({ kind: "CHORUS_CONFIG", path: explicit });
  }

  for (const layer of layers) {
    const raw = readJsonFile(layer.path);
    if (raw == null) continue;
    merged = mergeConfigPartial(merged, asPartialObject(raw, layer.path));
    sources.push({ kind: layer.kind, path: layer.path });
  }

  const parsed = chorusConfigSchema.parse(merged);
  const withEnv = applyEnvOverrides(parsed);
  if (withEnv.applied) {
    sources.push({ kind: "env" });
  }

  return { config: withEnv.config, sources };
}

function applyEnvOverrides(config: ChorusConfig): { config: ChorusConfig; applied: boolean } {
  let applied = false;
  const next: ChorusConfig = {
    security: { ...config.security },
    relay: { ...config.relay },
    backup: { ...config.backup },
    org: { ...config.org },
  };

  const port = process.env["CHORUS_PORT"];
  if (port) {
    const n = parseInt(port, 10);
    if (Number.isFinite(n)) {
      next.relay.port = n;
      applied = true;
    }
  }
  if (process.env["CHORUS_PUBLIC_HOST"]) {
    next.relay.publicHost = process.env["CHORUS_PUBLIC_HOST"];
    applied = true;
  }
  if (process.env["CHORUS_BIND"]) {
    next.relay.bind = process.env["CHORUS_BIND"];
    applied = true;
  }
  if (process.env["CHORUS_ALLOWED_CIDRS"]) {
    next.relay.allowedCidrs = process.env["CHORUS_ALLOWED_CIDRS"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    applied = true;
  }
  if (process.env["CHORUS_DENIED_CIDRS"]) {
    next.relay.deniedCidrs = process.env["CHORUS_DENIED_CIDRS"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    applied = true;
  }
  if (process.env["CHORUS_ALLOWED_PORTS"]) {
    next.relay.allowedPorts = process.env["CHORUS_ALLOWED_PORTS"]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 65535);
    applied = true;
  }
  if (process.env["CHORUS_ALLOW_OPEN_BIND"] !== undefined) {
    next.relay.allowOpenBind = parseEnvBool(process.env["CHORUS_ALLOW_OPEN_BIND"], true);
    applied = true;
  }
  if (process.env["CHORUS_ALLOW_LOOPBACK"] !== undefined) {
    next.relay.allowLoopback = parseEnvBool(process.env["CHORUS_ALLOW_LOOPBACK"], true);
    applied = true;
  }
  if (process.env["CHORUS_AWS_BUCKET"]) {
    next.backup.bucket = process.env["CHORUS_AWS_BUCKET"];
    applied = true;
  }
  if (process.env["CHORUS_AWS_REGION"]) {
    next.backup.region = process.env["CHORUS_AWS_REGION"];
    applied = true;
  }
  if (process.env["CHORUS_AWS_ENDPOINT"]) {
    next.backup.endpoint = process.env["CHORUS_AWS_ENDPOINT"];
    applied = true;
  }

  return { config: next, applied };
}

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/**
 * Resolve effective requireApproval for a share invocation.
 * Enterprise lock: when allowSkipApproval is false, always use config.requireApproval.
 */
export function resolveRequireApproval(
  security: ChorusConfig["security"],
  toolArg?: boolean
): boolean {
  if (!security.allowSkipApproval) {
    return security.requireApproval;
  }
  if (toolArg === undefined) return security.requireApproval;
  return toolArg;
}

export function resolveDefaultRole(
  security: ChorusConfig["security"],
  toolArg?: "edit" | "view" | "admin"
): "edit" | "view" | "admin" {
  return toolArg ?? security.defaultRole;
}

/** Trim and strip a leading @ from configured company email domains. */
export function normalizeAllowedEmailDomain(raw: string | undefined): string | undefined {
  const domain = raw?.trim().replace(/^@/, "").toLowerCase();
  return domain || undefined;
}

/** Domain enforced on join when configured or when requireEmailDomainMatch is locked on. */
export function resolveAllowedEmailDomain(
  security: ChorusConfig["security"]
): string | undefined {
  return normalizeAllowedEmailDomain(security.allowedEmailDomain);
}

export function emailDomainGateEnabled(security: ChorusConfig["security"]): boolean {
  return security.requireEmailDomainMatch || resolveAllowedEmailDomain(security) !== undefined;
}

/** Parse a raw object (tests / programmatic use) without filesystem. */
export function parseChorusConfig(raw: ChorusConfigFile | Record<string, unknown>): ChorusConfig {
  return chorusConfigSchema.parse(raw);
}

export { DEFAULT_CHORUS_CONFIG };
