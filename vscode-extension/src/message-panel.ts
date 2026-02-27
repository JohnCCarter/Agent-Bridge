import * as vscode from 'vscode';
import { DirectMessage } from './bridge-client';

interface LogEntry {
  kind: 'sent' | 'received' | 'broadcast' | 'system';
  from?: string;
  to?: string;
  payload: unknown;
  timestamp: string;
}

export class MessagePanel {
  private static current: MessagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly log: LogEntry[] = [];

  static createOrShow(context: vscode.ExtensionContext): MessagePanel {
    if (MessagePanel.current) {
      MessagePanel.current.panel.reveal();
      return MessagePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentBridgeMessages',
      'Agent Bridge – Messages',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const instance = new MessagePanel(panel, context);
    MessagePanel.current = instance;
    return instance;
  }

  private constructor(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => {
      MessagePanel.current = undefined;
    });
  }

  addEntry(entry: LogEntry): void {
    this.log.push(entry);
    this.panel.webview.postMessage({ type: 'append', entry });
  }

  addSystem(text: string): void {
    this.addEntry({ kind: 'system', payload: text, timestamp: new Date().toISOString() });
  }

  addReceived(msg: DirectMessage): void {
    this.addEntry({ kind: 'received', from: msg.from, to: msg.to, payload: msg.payload, timestamp: msg.timestamp });
  }

  addSent(to: string | undefined, payload: unknown): void {
    this.addEntry({ kind: to ? 'sent' : 'broadcast', to, payload, timestamp: new Date().toISOString() });
  }

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Bridge Messages</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 8px;
      gap: 8px;
    }
    #log {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .entry {
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      word-break: break-word;
    }
    .entry.received {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-left: 3px solid var(--vscode-charts-blue);
    }
    .entry.sent {
      background: var(--vscode-editor-selectionBackground);
      border-left: 3px solid var(--vscode-charts-green);
      text-align: right;
    }
    .entry.broadcast {
      background: var(--vscode-editor-selectionBackground);
      border-left: 3px solid var(--vscode-charts-yellow);
    }
    .entry.system {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 11px;
    }
    .meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .payload { white-space: pre-wrap; }
    #toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    input, select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;
    }
    input { flex: 1; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="log"></div>
  <div id="toolbar">
    <input id="input" type="text" placeholder="Message payload (JSON or text)..." />
    <input id="target" type="text" placeholder="To (leave blank to broadcast)" style="max-width:140px;" />
    <button id="send">Send</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const input = document.getElementById('input');
    const target = document.getElementById('target');
    const sendBtn = document.getElementById('send');

    function formatPayload(p) {
      if (typeof p === 'string') return p;
      return JSON.stringify(p, null, 2);
    }

    function appendEntry(e) {
      const div = document.createElement('div');
      div.className = 'entry ' + e.kind;
      const ts = new Date(e.timestamp).toLocaleTimeString();
      let meta = '';
      if (e.kind === 'received') meta = '<div class="meta">' + (e.from || '?') + ' → you · ' + ts + '</div>';
      else if (e.kind === 'sent') meta = '<div class="meta">you → ' + (e.to || '?') + ' · ' + ts + '</div>';
      else if (e.kind === 'broadcast') meta = '<div class="meta">you → ALL · ' + ts + '</div>';
      else meta = '<div class="meta">' + ts + '</div>';
      div.innerHTML = meta + '<div class="payload">' + formatPayload(e.payload).replace(/</g,'&lt;') + '</div>';
      log.appendChild(div);
      div.scrollIntoView();
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'append') appendEntry(msg.entry);
    });

    sendBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      vscode.postMessage({ type: 'send', to: target.value.trim() || undefined, payload });
      input.value = '';
    });

    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); } });
  </script>
</body>
</html>`;
  }
}
