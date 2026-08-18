import { z } from "zod";
/** Role granted to new share tokens when the host omits an explicit role. */
export const chorusRoleSchema = z.enum(["edit", "view", "admin"]);
const securityDefaults = {
    requireApproval: true,
    allowSkipApproval: true,
    requireRepoMatch: false,
    requireEmailDomainMatch: false,
    additionalRepoRemotePrefixes: [],
    repoRemoteRewrites: [],
    defaultRole: "edit",
};
export const chorusSecurityConfigSchema = z
    .object({
    /** Joiners wait for host approve/deny before seeing transcript or sending. */
    requireApproval: z.boolean().default(securityDefaults.requireApproval),
    /**
     * When true, tool/CLI attempts to set requireApproval=false are ignored.
     * Use for enterprise policy that must stay enforced.
     */
    allowSkipApproval: z.boolean().default(securityDefaults.allowSkipApproval),
    /**
     * When true, /chorus-share fails if the working tree has no git origin
     * (so the session always carries a repo gate).
     */
    requireRepoMatch: z.boolean().default(securityDefaults.requireRepoMatch),
    /**
     * When true, /chorus-share fails unless security.allowedEmailDomain is set,
     * and joiners must present an email at that domain.
     */
    requireEmailDomainMatch: z
        .boolean()
        .default(securityDefaults.requireEmailDomainMatch),
    /** Default role baked into issued join tokens. */
    defaultRole: chorusRoleSchema.default(securityDefaults.defaultRole),
    /** Company email domain for joiners (e.g. acme.com). Required when requireEmailDomainMatch is true. */
    allowedEmailDomain: z.string().min(1).optional(),
    /**
     * Extra git remote URL prefixes to strip when comparing remotes
     * (built-in: https://, ssh://, git@, …). Example: ["git://", "org-git://"].
     */
    additionalRepoRemotePrefixes: z
        .array(z.string().min(1).max(64))
        .max(32)
        .default([]),
    /**
     * Host substitutions after prefix stripping so internal clones match origin.
     * Example: [{ "from": "github.acme.com", "to": "github.com" }].
     */
    repoRemoteRewrites: z
        .array(z
        .object({
        from: z.string().min(1).max(253),
        to: z.string().min(1).max(253),
    })
        .strict())
        .max(32)
        .default([]),
    /** Optional TTL for join tokens (ms). Omit for non-expiring tokens. */
    tokenTtlMs: z.number().int().positive().optional(),
})
    .strict();
export const chorusRelayConfigSchema = z
    .object({
    port: z.number().int().min(1).max(65535).optional(),
    /** Host:port advertised in join URLs (overrides LAN detection). */
    publicHost: z.string().min(1).optional(),
})
    .strict();
export const chorusBackupConfigSchema = z
    .object({
    bucket: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
})
    .strict();
export const chorusOrgConfigSchema = z
    .object({
    /** Display name for status / policy notes (e.g. "Acme Engineering"). */
    name: z.string().min(1).optional(),
    /** Free-text policy blurb shown after share. */
    policyNote: z.string().optional(),
})
    .strict();
/**
 * On-disk Chorus configuration object.
 *
 * Layered load order (later wins): defaults → system → user → project → CHORUS_CONFIG.
 * Environment variables still override relay/backup ops fields.
 * Per-invocation tool args override security defaults unless locked by policy.
 */
export const chorusConfigSchema = z
    .object({
    security: chorusSecurityConfigSchema.default(securityDefaults),
    relay: chorusRelayConfigSchema.default({}),
    backup: chorusBackupConfigSchema.default({}),
    org: chorusOrgConfigSchema.default({}),
})
    .strict();
export const DEFAULT_CHORUS_CONFIG = chorusConfigSchema.parse({});
/** Deep-merge plain config objects (objects only; arrays replaced). */
export function mergeConfigPartial(base, overlay) {
    const out = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        if (value === undefined)
            continue;
        const prev = out[key];
        if (value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            prev &&
            typeof prev === "object" &&
            !Array.isArray(prev)) {
            out[key] = mergeConfigPartial(prev, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
//# sourceMappingURL=schema.js.map