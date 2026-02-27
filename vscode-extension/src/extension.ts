import * as vscode from 'vscode';
import * as os from 'os';
import { BridgeClient } from './bridge-client';
import { AgentsViewProvider } from './agents-view';
import { MessagePanel } from './message-panel';

let client: BridgeClient | null = null;
let agentsProvider: AgentsViewProvider | null = null;
let statusBarItem: vscode.StatusBarItem;
let agentRefreshTimer: NodeJS.Timeout | null = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('agentBridge');
  const serverUrl = cfg.get<string>('serverUrl') || 'http://localhost:3000';
  const agentName = cfg.get<string>('agentName') || `vscode-${os.hostname()}`;
  const agentType = cfg.get<string>('agentType') || 'vscode';
  const autoConnect = cfg.get<boolean>('autoConnect') || false;
  return { serverUrl, agentName, agentType, autoConnect };
}

async function connect(context: vscode.ExtensionContext): Promise<void> {
  if (client?.isConnected) {
    vscode.window.showInformationMessage('Agent Bridge: already connected.');
    return;
  }

  const { serverUrl, agentName, agentType } = getConfig();

  client = new BridgeClient(serverUrl, agentName, agentType);
  const panel = MessagePanel.createOrShow(context);

  client.on('registered', (peers: string[]) => {
    panel.addSystem(`Connected as "${agentName}". Peers online: ${peers.length > 0 ? peers.join(', ') : 'none'}`);
    updateStatusBar(true, agentName);
  });

  client.on('message', (msg) => {
    panel.addReceived(msg);
    vscode.window.showInformationMessage(`Agent Bridge: message from ${msg.from}`);
  });

  client.on('broadcast', (msg) => {
    panel.addReceived(msg);
  });

  client.on('agentJoined', (name: string) => {
    panel.addSystem(`Agent joined: ${name}`);
    refreshAgentList();
  });

  client.on('agentLeft', (name: string) => {
    panel.addSystem(`Agent left: ${name}`);
    refreshAgentList();
  });

  client.on('disconnected', () => {
    panel.addSystem('Disconnected from Agent-Bridge.');
    updateStatusBar(false);
    stopAgentRefresh();
  });

  try {
    await client.registerWithRest();
    await client.connect();
    startAgentRefresh();
  } catch (err) {
    vscode.window.showErrorMessage(`Agent Bridge: failed to connect – ${String(err)}`);
    client = null;
    updateStatusBar(false);
  }

  // Handle messages sent from the Webview toolbar
  // Note: panel is set up to postMessage back with { type: 'send', to?, payload }
  // We listen via the panel's webview
}

async function disconnect(): Promise<void> {
  stopAgentRefresh();
  client?.disconnect();
  client = null;
  updateStatusBar(false);
}

async function refreshAgentList(): Promise<void> {
  if (!client) { return; }
  try {
    const agents = await client.fetchAgents();
    agentsProvider?.refresh(agents);
  } catch {
    // server may be temporarily unreachable
  }
}

function startAgentRefresh(): void {
  stopAgentRefresh();
  agentRefreshTimer = setInterval(refreshAgentList, 10_000);
  void refreshAgentList();
}

function stopAgentRefresh(): void {
  if (agentRefreshTimer) {
    clearInterval(agentRefreshTimer);
    agentRefreshTimer = null;
  }
}

function updateStatusBar(connected: boolean, agentName?: string): void {
  if (connected && agentName) {
    statusBarItem.text = `$(radio-tower) AB: ${agentName}`;
    statusBarItem.tooltip = 'Agent Bridge connected – click to disconnect';
    statusBarItem.command = 'agentBridge.disconnect';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(radio-tower) Agent Bridge';
    statusBarItem.tooltip = 'Agent Bridge disconnected – click to connect';
    statusBarItem.command = 'agentBridge.connect';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.show();
  updateStatusBar(false);
  context.subscriptions.push(statusBarItem);

  agentsProvider = new AgentsViewProvider(client!);
  vscode.window.registerTreeDataProvider('agentBridge.agentsView', agentsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.connect', () => connect(context)),

    vscode.commands.registerCommand('agentBridge.disconnect', disconnect),

    vscode.commands.registerCommand('agentBridge.showPanel', () => {
      MessagePanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('agentBridge.sendMessage', async (toArg?: string) => {
      if (!client?.isConnected) {
        vscode.window.showWarningMessage('Agent Bridge: not connected. Run "Agent Bridge: Connect" first.');
        return;
      }
      const to = toArg ?? await vscode.window.showInputBox({ prompt: 'Recipient agent name (leave blank to broadcast)' });
      const text = await vscode.window.showInputBox({ prompt: 'Message payload (text or JSON)' });
      if (text === undefined) { return; }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = text; }
      const panel = MessagePanel.createOrShow(context);
      if (to) {
        client.sendDirect(to, payload);
        panel.addSent(to, payload);
      } else {
        client.broadcast(payload);
        panel.addSent(undefined, payload);
      }
    }),

    vscode.commands.registerCommand('agentBridge.broadcast', async () => {
      if (!client?.isConnected) {
        vscode.window.showWarningMessage('Agent Bridge: not connected.');
        return;
      }
      const text = await vscode.window.showInputBox({ prompt: 'Broadcast payload (text or JSON)' });
      if (text === undefined) { return; }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = text; }
      const panel = MessagePanel.createOrShow(context);
      client.broadcast(payload);
      panel.addSent(undefined, payload);
    })
  );

  const { autoConnect } = getConfig();
  if (autoConnect) {
    void connect(context);
  }
}

export function deactivate(): void {
  stopAgentRefresh();
  client?.disconnect();
}
