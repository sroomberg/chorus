/**
 * Normalize a git remote URL for equality checks across SSH/HTTPS forms.
 * Examples:
 *   git@github.com:org/repo.git  → github.com/org/repo
 *   https://github.com/org/repo  → github.com/org/repo
 *   ssh://git@gitlab.com/org/repo.git → gitlab.com/org/repo
 */
export declare function normalizeRepoRemote(raw: string): string;
export declare function repoRemotesMatch(a: string | undefined | null, b: string | undefined | null): boolean;
//# sourceMappingURL=repo.d.ts.map