import type { RepoRemoteRewrite } from "./types.js";

const BUILTIN_PREFIXES = [
  "git+https://",
  "https://",
  "http://",
  "ssh://git@",
  "ssh://",
  "git@",
];

export interface NormalizeRepoRemoteOptions {
  extraPrefixes?: string[];
  rewrites?: RepoRemoteRewrite[];
}

/**
 * Normalize a git remote URL for equality checks across SSH/HTTPS forms.
 * Examples:
 *   git@github.com:org/repo.git  → github.com/org/repo
 *   https://github.com/org/repo  → github.com/org/repo
 *   ssh://git@gitlab.com/org/repo.git → gitlab.com/org/repo
 */
export function normalizeRepoRemote(raw: string, opts?: NormalizeRepoRemoteOptions): string {
  let s = raw.trim();
  if (!s) return "";

  s = s.replace(/\.git$/i, "");

  const scp = s.match(/^git@([^:]+):(.+)$/i);
  if (scp) {
    const normalized = `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`.replace(
      /\/+$/,
      ""
    );
    return applyRepoRemoteRewrites(normalized, opts?.rewrites);
  }

  s = stripRepoRemotePrefix(s.toLowerCase(), opts?.extraPrefixes);

  // Drop credentials: user:pass@host/...
  s = s.replace(/^[^@/]+@/, "");

  return applyRepoRemoteRewrites(s.replace(/\/+$/, ""), opts?.rewrites);
}

function stripRepoRemotePrefix(lower: string, extraPrefixes?: string[]): string {
  const prefixes = [
    ...(extraPrefixes ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean),
    ...BUILTIN_PREFIXES,
  ].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return lower.slice(prefix.length);
    }
  }
  return lower;
}

function applyRepoRemoteRewrites(normalized: string, rewrites?: RepoRemoteRewrite[]): string {
  let out = normalized;
  for (const rule of rewrites ?? []) {
    const from = rule.from.trim().replace(/\/+$/, "").toLowerCase();
    const to = rule.to.trim().replace(/\/+$/, "").toLowerCase();
    if (!from) continue;
    if (out === from || out.startsWith(`${from}/`)) {
      out = `${to}${out.slice(from.length)}`;
    }
  }
  return out;
}

export function repoRemotesMatch(
  a: string | undefined | null,
  b: string | undefined | null,
  opts?: NormalizeRepoRemoteOptions
): boolean {
  const na = a ? normalizeRepoRemote(a, opts) : "";
  const nb = b ? normalizeRepoRemote(b, opts) : "";
  if (!na || !nb) return false;
  return na === nb;
}
