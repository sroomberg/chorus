import * as vscode from "vscode";
import type { ChorusController, TranscriptLine } from "./controller.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lineClass(line: TranscriptLine): string {
  if (line.kind === "chat") return "chat";
  if (line.kind === "system") return "system";
  if (line.text.startsWith("[AI]:")) return "ai";
  if (line.text.startsWith("[Host]:")) return "host";
  return "user";
}

export class SessionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "chorus.session";
  private view?: vscode.WebviewView;

  constructor(private readonly controller: ChorusController) {
    controller.onDidChange(() => this.render());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "chat" && typeof msg.text === "string") {
        try {
          this.controller.sendChat(msg.text);
        } catch (err) {
          void vscode.window.showErrorMessage(String(err));
        }
      }
      if (msg?.type === "prompt" && typeof msg.text === "string") {
        try {
          this.controller.sendPrompt(msg.text);
        } catch (err) {
          void vscode.window.showErrorMessage(String(err));
        }
      }
      if (msg?.type === "publish" && typeof msg.text === "string") {
        try {
          this.controller.publishHostMessage(msg.text, "user");
        } catch (err) {
          void vscode.window.showErrorMessage(String(err));
        }
      }
    });
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const mode = this.controller.getMode();
    const lines = this.controller.getTranscript();
    const body = lines
      .map(
        (l) =>
          `<div class="line ${lineClass(l)}"><pre>${escapeHtml(l.text)}</pre></div>`
      )
      .join("");

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 8px; color: var(--vscode-foreground); }
  .meta { opacity: 0.7; margin-bottom: 8px; }
  .feed { display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 140px); overflow: auto; }
  .line { padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-foreground)); }
  .line.system { opacity: 0.75; font-style: italic; }
  .line.chat { border-left: 3px solid var(--vscode-charts-blue); }
  .line.ai { border-left: 3px solid var(--vscode-charts-green); }
  .line.host { border-left: 3px solid var(--vscode-charts-orange); }
  .line.user { border-left: 3px solid var(--vscode-charts-purple); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
  .compose { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; position: sticky; bottom: 0; background: var(--vscode-sideBar-background); padding-top: 8px; }
  input, button { font: inherit; padding: 6px 8px; }
  .row { display: flex; gap: 6px; }
  button { cursor: pointer; }
</style>
</head>
<body>
  <div class="meta">Mode: <strong>${escapeHtml(mode)}</strong></div>
  <div class="feed" id="feed">${body || "<div class='line system'><pre>Idle — Share or Join a Chorus session.</pre></div>"}</div>
  <div class="compose">
    <div class="row">
      <input id="msg" type="text" placeholder="${mode === "joined" ? "Prompt for host…" : mode === "sharing" ? "Publish host message…" : "Chat / prompt…"}" style="flex:1" />
      <button id="send">${mode === "joined" ? "Send prompt" : mode === "sharing" ? "Publish" : "Chat"}</button>
    </div>
    <div class="row">
      <button id="chat">Side-channel chat</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('msg');
    const send = document.getElementById('send');
    const chat = document.getElementById('chat');
    const mode = ${JSON.stringify(mode)};
    function primary() {
      const text = input.value.trim();
      if (!text) return;
      if (mode === 'joined') vscode.postMessage({ type: 'prompt', text });
      else if (mode === 'sharing') vscode.postMessage({ type: 'publish', text });
      else vscode.postMessage({ type: 'chat', text });
      input.value = '';
    }
    send.addEventListener('click', primary);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') primary(); });
    chat.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'chat', text });
      input.value = '';
    });
    const feed = document.getElementById('feed');
    feed.scrollTop = feed.scrollHeight;
  </script>
</body>
</html>`;
  }
}
