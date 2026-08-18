import { z } from "zod";
/** Role granted to new share tokens when the host omits an explicit role. */
export declare const chorusRoleSchema: z.ZodEnum<{
    admin: "admin";
    edit: "edit";
    view: "view";
}>;
export declare const chorusSecurityConfigSchema: z.ZodObject<{
    requireApproval: z.ZodDefault<z.ZodBoolean>;
    allowSkipApproval: z.ZodDefault<z.ZodBoolean>;
    requireRepoMatch: z.ZodDefault<z.ZodBoolean>;
    requireEmailDomainMatch: z.ZodDefault<z.ZodBoolean>;
    defaultRole: z.ZodDefault<z.ZodEnum<{
        admin: "admin";
        edit: "edit";
        view: "view";
    }>>;
    allowedEmailDomain: z.ZodOptional<z.ZodString>;
    additionalRepoRemotePrefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    repoRemoteRewrites: z.ZodDefault<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>>>;
    tokenTtlMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const chorusRelayConfigSchema: z.ZodObject<{
    port: z.ZodOptional<z.ZodNumber>;
    publicHost: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const chorusBackupConfigSchema: z.ZodObject<{
    bucket: z.ZodOptional<z.ZodString>;
    region: z.ZodOptional<z.ZodString>;
    endpoint: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const chorusOrgConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    policyNote: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/**
 * On-disk Chorus configuration object.
 *
 * Layered load order (later wins): defaults → system → user → project → CHORUS_CONFIG.
 * Environment variables still override relay/backup ops fields.
 * Per-invocation tool args override security defaults unless locked by policy.
 */
export declare const chorusConfigSchema: z.ZodObject<{
    security: z.ZodDefault<z.ZodObject<{
        requireApproval: z.ZodDefault<z.ZodBoolean>;
        allowSkipApproval: z.ZodDefault<z.ZodBoolean>;
        requireRepoMatch: z.ZodDefault<z.ZodBoolean>;
        requireEmailDomainMatch: z.ZodDefault<z.ZodBoolean>;
        defaultRole: z.ZodDefault<z.ZodEnum<{
            admin: "admin";
            edit: "edit";
            view: "view";
        }>>;
        allowedEmailDomain: z.ZodOptional<z.ZodString>;
        additionalRepoRemotePrefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        repoRemoteRewrites: z.ZodDefault<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, z.core.$strict>>>;
        tokenTtlMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    relay: z.ZodDefault<z.ZodObject<{
        port: z.ZodOptional<z.ZodNumber>;
        publicHost: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    backup: z.ZodDefault<z.ZodObject<{
        bucket: z.ZodOptional<z.ZodString>;
        region: z.ZodOptional<z.ZodString>;
        endpoint: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    org: z.ZodDefault<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        policyNote: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ChorusConfigFile = z.input<typeof chorusConfigSchema>;
export type ChorusConfig = z.output<typeof chorusConfigSchema>;
export type ChorusSecurityConfig = ChorusConfig["security"];
export declare const DEFAULT_CHORUS_CONFIG: ChorusConfig;
/** Deep-merge plain config objects (objects only; arrays replaced). */
export declare function mergeConfigPartial(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=schema.d.ts.map