import * as vscode from "vscode";
import type { ChorusController } from "./controller.js";
import { escapeHtml, wrapHtml } from "./ui.js";

/**
 * Sidebar: start/stop the relay, copy the join command, approve joiners.
 */
export class RelayViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "chorus.relay";
  private view?: vscode.WebviewView;

  constructor(private readonly controller: ChorusController) {
    controller.onDidChange(() => this.render());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.onMessage(msg);
    });
    this.render();
  }

  private async onMessage(msg: { type?: string; role?: string; token?: string; host?: string; name?: string; userId?: string }): Promise<void> {
    try {
      if (msg?.type === "share") {
        const role = (msg.role === "view" || msg.role === "admin" ? msg.role : "edit") as "edit" | "view" | "admin";
        await vscode.commands.executeCommand("chorus.share", role);
        return;
      }
      if (msg?.type === "stop") {
        await vscode.commands.executeCommand("chorus.stop");
        return;
      }
      if (msg?.type === "leave") {
        await vscode.commands.executeCommand("chorus.leave");
        return;
      }
      if (msg?.type === "copyJoin") {
        const cmd = this.controller.getJoinCommand();
        if (cmd) await vscode.env.clipboard.writeText(cmd);
        return;
      }
      if (msg?.type === "join") {
        if (!msg.token?.trim() || !msg.host?.trim()) {
          void vscode.window.showErrorMessage("Token and host are required to join.");
          return;
        }
        await vscode.commands.executeCommand(
          "chorus.joinWithArgs",
          msg.token.trim(),
          msg.host.trim(),
          msg.name?.trim()
        );
        return;
      }
      if (msg?.type === "approve" && msg.userId) this.controller.approveUser(msg.userId);
      if (msg?.type === "deny" && msg.userId) this.controller.denyUser(msg.userId);
      if (msg?.type === "openChat") await vscode.commands.executeCommand("chorus.openChatWindow");
      if (msg?.type === "openAgent") await vscode.commands.executeCommand("chorus.openAgentWindow");
    } catch (err) {
      void vscode.window.showErrorMessage(String(err));
    }
  }

  private render(): void {
    if (!this.view) return;
    const mode = this.controller.getMode();
    const share = this.controller.getShareSummary();
    const joinCmd = this.controller.getJoinCommand();
    const pending = this.controller.getPendingUsers();
    const cfg = vscode.workspace.getConfiguration("chorus");
    const defaultName = cfg.get<string>("displayName") || process.env["USER"] || "";
    const defaultHost = cfg.get<string>("publicHost") || `127.0.0.1:${cfg.get<number>("port") ?? 7742}`;

    const pendingHtml = pending.length
      ? pending
          .map(
            (u) => `<div class="pending">${escapeHtml(u.displayName)} <span class="meta">${escapeHtml(u.role)} · ${escapeHtml(u.userId)}</span>
              <button data-act="approve" data-id="${escapeHtml(u.userId)}">Approve</button>
              <button data-act="deny" data-id="${escapeHtml(u.userId)}">Deny</button></div>`
          )
          .join("")
      : "<div class='meta'>No pending joiners.</div>";

    const body = `
  <div class="meta">Relay: <strong>${escapeHtml(mode)}</strong>${
    share.sharing ? ` · :${share.port} · ${share.clients ?? 0} clients` : ""
  }</div>
  <p class="hint">Start a relay from this panel. Chat and Agent open as separate windows; the host editor stays in the main window. Joiners send chat and prompts over the relay — they do not remote-control your cursor.</p>
  <div class="stack">
    <div class="row">
      <select id="role">
        <option value="edit">edit</option>
        <option value="view">view</option>
        <option value="admin">admin</option>
      </select>
      <button id="share"${mode === "sharing" ? " disabled" : ""}>Start relay</button>
      <button id="stop"${mode === "sharing" ? "" : " disabled"}>Stop</button>
    </div>
    <div class="row">
      <button id="openChat">Open chat window</button>
      <button id="openAgent">Open agent window</button>
    </div>
    ${
      joinCmd
        ? `<div class="join-cmd" id="joinCmd">${escapeHtml(joinCmd)}</div>
           <button id="copyJoin">Copy join command</button>`
        : ""
    }
    <h4>Pending</h4>
    ${pendingHtml}
    <h4>Join another host</h4>
    <input id="token" placeholder="join token" ${mode === "sharing" ? "disabled" : ""} />
    <input id="host" placeholder="host:port" value="${escapeHtml(defaultHost)}" ${mode === "sharing" ? "disabled" : ""} />
    <input id="name" placeholder="display name" value="${escapeHtml(defaultName)}" />
    <div class="row">
      <button id="join"${mode === "sharing" ? " disabled" : ""}>Join relay</button>
      <button id="leave"${mode === "joined" || mode === "pending" ? "" : " disabled"}>Leave</button>
    </div>
  </div>`;

    const script = `
    document.getElementById('share')?.addEventListener('click', () => {
      const role = document.getElementById('role').value;
      vscode.postMessage({ type: 'share', role });
    });
    document.getElementById('stop')?.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('leave')?.addEventListener('click', () => vscode.postMessage({ type: 'leave' }));
    document.getElementById('copyJoin')?.addEventListener('click', () => vscode.postMessage({ type: 'copyJoin' }));
    document.getElementById('openChat')?.addEventListener('click', () => vscode.postMessage({ type: 'openChat' }));
    document.getElementById('openAgent')?.addEventListener('click', () => vscode.postMessage({ type: 'openAgent' }));
    document.getElementById('join')?.addEventListener('click', () => {
      vscode.postMessage({
        type: 'join',
        token: document.getElementById('token').value,
        host: document.getElementById('host').value,
        name: document.getElementById('name').value
      });
    });
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: btn.getAttribute('data-act'), userId: btn.getAttribute('data-id') });
      });
    });
    `;

    this.view.webview.html = wrapHtml("Chorus Relay", body, script);
  }
}
