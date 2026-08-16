import { execFileSync } from "node:child_process";
import * as vscode from "vscode";

/** Best-effort `git remote get-url origin` for the active workspace folder. */
export function detectRepoRemote(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return undefined;
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: folder,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
