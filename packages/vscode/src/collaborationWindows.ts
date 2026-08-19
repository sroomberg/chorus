import * as vscode from "vscode";
import type { ChorusController, TranscriptLine } from "./controller.js";
import { escapeHtml, renderLines, wrapHtml } from "./ui.js";

const MOVE_TO_NEW_WINDOW = "workbench.action.moveEditorToNewWindow";

/**
 * Chat and Agent are editor webview panels so they can live in their own windows.
 * The host workspace editor stays in the original window.
 */
export class CollaborationWindows implements vscode.Disposable {
  private chat?: vscode.WebviewPanel;
  private agent?: vscode.WebviewPanel;
  private readonly sub: vscode.Disposable;

  constructor(private readonly controller: ChorusController) {
    this.sub = controller.onDidChange(() => {
      this.renderChat();
      this.renderAgent();
    });
  }

  dispose(): void {
    this.sub.dispose();
    this.chat?.dispose();
    this.agent?.dispose();
  }

  async openChat(moveToNewWindow = true): Promise<void> {
    if (this.chat) {
      this.chat.reveal(undefined, false);
      return;
    }
    this.chat = vscode.window.createWebviewPanel(
      "chorus.chat",
      "Chorus Chat",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.chat.onDidDispose(() => {
      this.chat = undefined;
    });
    this.chat.webview.onDidReceiveMessage((msg) => this.onChatMessage(msg));
    this.renderChat();
    if (moveToNewWindow) await moveActiveEditorToNewWindow();
  }

  async openAgent(moveToNewWindow = true): Promise<void> {
    if (this.agent) {
      this.agent.reveal(undefined, false);
      return;
    }
    this.agent = vscode.window.createWebviewPanel(
      "chorus.agent",
      "Chorus Agent",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.agent.onDidDispose(() => {
      this.agent = undefined;
    });
    this.agent.webview.onDidReceiveMessage((msg) => this.onAgentMessage(msg));
    this.renderAgent();
    if (moveToNewWindow) await moveActiveEditorToNewWindow();
  }

  async openBoth(): Promise<void> {
    await this.openChat(true);
    await this.openAgent(true);
  }

  private onChatMessage(msg: { type?: string; text?: string }): void {
    if (msg?.type === "chat" && typeof msg.text === "string") {
      try {
        this.controller.sendChat(msg.text);
      } catch (err) {
        void vscode.window.showErrorMessage(String(err));
      }
    }
  }

  private onAgentMessage(msg: { type?: string; text?: string }): void {
    try {
      if (msg?.type === "prompt" && typeof msg.text === "string") {
        this.controller.sendPrompt(msg.text);
        return;
      }
      if (msg?.type === "publish" && typeof msg.text === "string") {
        this.controller.publishHostMessage(msg.text, "user");
        return;
      }
      if (msg?.type === "insert" && typeof msg.text === "string") {
        insertIntoActiveEditor(msg.text);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(String(err));
    }
  }

  private renderChat(): void {
    if (!this.chat) return;
    const mode = this.controller.getMode();
    const lines = this.controller.getTranscript().filter((l) => l.kind === "chat");
    const body = `
  <div class="meta">Side-channel chat · mode <strong>${escapeHtml(mode)}</strong></div>
  <p class="hint">This window is for people talking to people. It does not enter the LLM transcript.</p>
  <div class="feed" id="feed">${renderLines(lines) || "<div class='line system'><pre>No chat yet.</pre></div>"}</div>
  <div class="compose">
    <div class="row">
      <input id="msg" type="text" placeholder="Chat message…" style="flex:1" ${mode === "idle" || mode === "pending" ? "disabled" : ""} />
      <button id="send" ${mode === "idle" || mode === "pending" ? "disabled" : ""}>Send</button>
    </div>
  </div>`;
    const script = `
    const input = document.getElementById('msg');
    document.getElementById('send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    function send() {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'chat', text });
      input.value = '';
    }
    const feed = document.getElementById('feed');
    feed.scrollTop = feed.scrollHeight;
    `;
    this.chat.webview.html = wrapHtml("Chorus Chat", body, script);
  }

  private renderAgent(): void {
    if (!this.agent) return;
    const mode = this.controller.getMode();
    const lines = this.controller.getTranscript().filter((l) => l.kind === "session");
    const placeholder =
      mode === "joined" ? "Prompt for the host agent…" : mode === "sharing" ? "Publish a host/AI line…" : "Share or join first…";
    const primary = mode === "joined" ? "Send prompt" : "Publish";
    const body = `
  <div class="meta">Agent session · mode <strong>${escapeHtml(mode)}</strong></div>
  <p class="hint">Collaborator prompts land here. Apply them in the host editor (Insert at cursor uses the original VS Code window). This is not a remote desktop — joiners cannot type in your files directly.</p>
  <div class="feed" id="feed">${agentFeed(lines)}</div>
  <div class="compose">
    <div class="row">
      <input id="msg" type="text" placeholder="${escapeHtml(placeholder)}" style="flex:1" ${mode === "idle" || mode === "pending" ? "disabled" : ""} />
      <button id="send" ${mode === "idle" || mode === "pending" ? "disabled" : ""}>${escapeHtml(primary)}</button>
    </div>
  </div>`;
    const script = `
    const input = document.getElementById('msg');
    const mode = ${JSON.stringify(mode)};
    document.getElementById('send').addEventListener('click', primary);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') primary(); });
    function primary() {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({ type: mode === 'joined' ? 'prompt' : 'publish', text });
      input.value = '';
    }
    document.querySelectorAll('[data-insert]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'insert', text: btn.getAttribute('data-insert') });
      });
    });
    const feed = document.getElementById('feed');
    feed.scrollTop = feed.scrollHeight;
    `;
    this.agent.webview.html = wrapHtml("Chorus Agent", body, script);
  }
}

function agentFeed(lines: readonly TranscriptLine[]): string {
  if (!lines.length) return "<div class='line system'><pre>No agent events yet.</pre></div>";
  return lines
    .map((l) => {
      const insert = `<button data-insert="${escapeHtml(stripLabel(l.text))}">Insert at cursor</button>`;
      return `<div class="line ${l.text.startsWith("[AI]:") ? "ai" : l.text.startsWith("[Host]:") ? "host" : "user"}"><pre>${escapeHtml(l.text)}</pre>${insert}</div>`;
    })
    .join("");
}

function stripLabel(text: string): string {
  return text.replace(/^\[[^\]]+\]:\s*/, "");
}

function insertIntoActiveEditor(text: string): void {
  const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
  if (!editor) {
    void vscode.window.showWarningMessage(
      "Focus a file in the host editor window, then Insert at cursor."
    );
    return;
  }
  void editor.edit((builder) => {
    builder.insert(editor.selection.active, text);
  });
}

async function moveActiveEditorToNewWindow(): Promise<void> {
  try {
    await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW);
  } catch {
    // Command missing in older hosts — leave the panel in the current window.
  }
}
