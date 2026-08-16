import { execFileSync } from "node:child_process";
/** Best-effort `git remote get-url origin` for the working directory. */
export function detectRepoRemote(cwd) {
    try {
        const out = execFileSync("git", ["remote", "get-url", "origin"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
        }).trim();
        return out || undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=git.js.map