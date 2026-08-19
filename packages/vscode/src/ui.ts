import type { ChorusMode, TranscriptLine } from "./controller.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function lineClass(line: TranscriptLine): string {
  if (line.kind === "chat") return "chat";
  if (line.kind === "system") return "system";
  if (line.text.startsWith("[AI]:")) return "ai";
  if (line.text.startsWith("[Host]:")) return "host";
  return "user";
}

export function renderLines(lines: readonly TranscriptLine[]): string {
  if (!lines.length) return "";
  return lines
    .map(
      (l) =>
        `<div class="line ${lineClass(l)}" data-id="${escapeHtml(l.id)}"><pre>${escapeHtml(l.text)}</pre></div>`
    )
    .join("");
}

export const WEBVIEW_CSS = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 8px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.meta { opacity: 0.7; margin-bottom: 8px; }
.hint { opacity: 0.8; margin: 0 0 10px; line-height: 1.4; }
.feed { display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 160px); overflow: auto; }
.line { padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-foreground)); }
.line.system { opacity: 0.75; font-style: italic; }
.line.chat { border-left: 3px solid var(--vscode-charts-blue); }
.line.ai { border-left: 3px solid var(--vscode-charts-green); }
.line.host { border-left: 3px solid var(--vscode-charts-orange); }
.line.user { border-left: 3px solid var(--vscode-charts-purple); }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
.compose, .stack { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
input, button, select { font: inherit; padding: 6px 8px; }
button { cursor: pointer; }
.join-cmd { font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
.pending { margin: 8px 0; }
.pending button { margin-left: 4px; }
`;

export function wrapHtml(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>${escapeHtml(title)}</title>
<style>${WEBVIEW_CSS}</style>
</head>
<body>
${body}
<script>
const vscode = acquireVsCodeApi();
${script}
</script>
</body>
</html>`;
}

export function modeLabel(mode: ChorusMode): string {
  return mode;
}
