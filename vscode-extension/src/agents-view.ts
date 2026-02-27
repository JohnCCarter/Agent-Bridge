import * as vscode from 'vscode';
import { AgentInfo, BridgeClient } from './bridge-client';

export class AgentItem extends vscode.TreeItem {
  constructor(public readonly agent: AgentInfo) {
    super(agent.name, vscode.TreeItemCollapsibleState.None);

    const statusIcon: Record<string, string> = {
      online: '$(circle-filled)',
      busy: '$(loading~spin)',
      offline: '$(circle-outline)'
    };
    this.label = `${statusIcon[agent.status] ?? '$(circle-outline)'} ${agent.name}`;
    this.description = `${agent.type} · ${agent.status}`;
    this.tooltip = `${agent.name}\nType: ${agent.type}\nStatus: ${agent.status}\nCapabilities: ${agent.capabilities.join(', ') || 'none'}`;
    this.contextValue = 'agentItem';
    this.command = {
      command: 'agentBridge.sendMessage',
      title: 'Send Message',
      arguments: [agent.name]
    };
  }
}

export class AgentsViewProvider implements vscode.TreeDataProvider<AgentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private agents: AgentInfo[] = [];

  constructor(private readonly client: BridgeClient) {}

  refresh(agents: AgentInfo[]): void {
    this.agents = agents;
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: AgentItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AgentItem[] {
    return this.agents.map(a => new AgentItem(a));
  }
}
