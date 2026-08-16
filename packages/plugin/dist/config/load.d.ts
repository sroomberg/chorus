import { DEFAULT_CHORUS_CONFIG, type ChorusConfig, type ChorusConfigFile } from "./schema.js";
export type ConfigSource = "defaults" | "system" | "user" | "project" | "CHORUS_CONFIG" | "env";
export interface LoadedChorusConfig {
    config: ChorusConfig;
    /** Absolute paths that contributed (missing files omitted). */
    sources: Array<{
        kind: ConfigSource;
        path?: string;
    }>;
}
/** Candidate paths for a project working directory (first existing wins as "project"). */
export declare function projectConfigPaths(projectDir: string): string[];
export declare function userConfigPath(): string;
export declare function systemConfigPath(): string;
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
export declare function loadChorusConfig(projectDir?: string): LoadedChorusConfig;
/**
 * Resolve effective requireApproval for a share invocation.
 * Enterprise lock: when allowSkipApproval is false, always use config.requireApproval.
 */
export declare function resolveRequireApproval(security: ChorusConfig["security"], toolArg?: boolean): boolean;
export declare function resolveDefaultRole(security: ChorusConfig["security"], toolArg?: "edit" | "view" | "admin"): "edit" | "view" | "admin";
/** Parse a raw object (tests / programmatic use) without filesystem. */
export declare function parseChorusConfig(raw: ChorusConfigFile | Record<string, unknown>): ChorusConfig;
export { DEFAULT_CHORUS_CONFIG };
//# sourceMappingURL=load.d.ts.map