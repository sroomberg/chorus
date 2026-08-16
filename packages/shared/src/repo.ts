/**
 * Normalize a git remote URL for equality checks across SSH/HTTPS forms.
 * Examples:
 *   git@github.com:org/repo.git  → github.com/org/repo
 *   https://github.com/org/repo  → github.com/org/repo
 *   ssh://git@gitlab.com/org/repo.git → gitlab.com/org/repo
 */
export function normalizeRepoRemote(raw: string): string {
  let s = raw.trim();
  if (!s) return "";

  s = s.replace(/\.git$/i, "");

  const scp = s.match(/^git@([^:]+):(.+)$/i);
  if (scp) {
    return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`.replace(/\/+$/, "");
  }

  s = s.replace(/^(?:git\+)?https?:\/\//i, "");
  s = s.replace(/^ssh:\/\/(?:git@)?/i, "");
  s = s.replace(/^git@/i, "");

  // Drop credentials: user:pass@host/...
  s = s.replace(/^[^@/]+@/, "");

  return s.replace(/\/+$/, "").toLowerCase();
}

export function repoRemotesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = a ? normalizeRepoRemote(a) : "";
  const nb = b ? normalizeRepoRemote(b) : "";
  if (!na || !nb) return false;
  return na === nb;
}
