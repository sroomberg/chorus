import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chorusConfigSchema, DEFAULT_CHORUS_CONFIG, mergeConfigPartial, } from "./schema.js";
function readJsonFile(path) {
    if (!existsSync(path))
        return null;
    try {
        const raw = readFileSync(path, "utf8");
        return JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Invalid Chorus config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function asPartialObject(value, path) {
    if (value == null)
        return {};
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Chorus config at ${path} must be a JSON object`);
    }
    return value;
}
/** Candidate paths for a project working directory (first existing wins as "project"). */
export function projectConfigPaths(projectDir) {
    return [join(projectDir, "chorus.json"), join(projectDir, ".chorus", "config.json")];
}
export function userConfigPath() {
    return process.env["CHORUS_USER_CONFIG"] ?? join(homedir(), ".config", "chorus", "config.json");
}
export function systemConfigPath() {
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
 *   6. selected environment overrides (relay port, public host, backup)
 */
export function loadChorusConfig(projectDir) {
    const sources = [{ kind: "defaults" }];
    let merged = {};
    const layers = [
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
        if (raw == null)
            continue;
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
function applyEnvOverrides(config) {
    let applied = false;
    const next = {
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
/**
 * Resolve effective requireApproval for a share invocation.
 * Enterprise lock: when allowSkipApproval is false, always use config.requireApproval.
 */
export function resolveRequireApproval(security, toolArg) {
    if (!security.allowSkipApproval) {
        return security.requireApproval;
    }
    if (toolArg === undefined)
        return security.requireApproval;
    return toolArg;
}
export function resolveDefaultRole(security, toolArg) {
    return toolArg ?? security.defaultRole;
}
/** Parse a raw object (tests / programmatic use) without filesystem. */
export function parseChorusConfig(raw) {
    return chorusConfigSchema.parse(raw);
}
export { DEFAULT_CHORUS_CONFIG };
//# sourceMappingURL=load.js.map