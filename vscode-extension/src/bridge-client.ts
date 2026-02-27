import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface AgentInfo {
  name: string;
  type: string;
  capabilities: string[];
  status: string;
  registeredAt: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

export interface DirectMessage {
  from: string;
  to?: string;
  payload: unknown;
  timestamp: string;
}

export class BridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly serverUrl: string;
  private readonly agentName: string;
  private readonly agentType: string;

  constructor(serverUrl: string, agentName: string, agentType = 'vscode') {
    super();
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.agentName = agentName;
    this.agentType = agentType;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.serverUrl.replace(/^http/, 'ws') + '/ws';
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'register', from: this.agentName }));
        this.startHeartbeat();
        resolve();
      });

      ws.once('error', (err) => {
        reject(err);
      });

      ws.on('message', (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handleMessage(msg);
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        this.ws = null;
        this.emit('disconnected');
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'registered':
        this.emit('registered', msg.peers);
        break;
      case 'message':
        this.emit('message', {
          from: msg.from,
          to: msg.to,
          payload: msg.payload,
          timestamp: msg.timestamp
        } as DirectMessage);
        break;
      case 'broadcast':
        this.emit('broadcast', {
          from: msg.from,
          payload: msg.payload,
          timestamp: msg.timestamp
        } as DirectMessage);
        break;
      case 'agent.joined':
        this.emit('agentJoined', msg.agent);
        break;
      case 'agent.left':
        this.emit('agentLeft', msg.agent);
        break;
      case 'agent.status':
        this.emit('agentStatus', { agent: msg.agent, status: msg.status });
        break;
      default:
        break;
    }
  }

  sendDirect(to: string, payload: unknown): void {
    this.send({ type: 'message', from: this.agentName, to, payload });
  }

  broadcast(payload: unknown): void {
    this.send({ type: 'broadcast', from: this.agentName, payload });
  }

  private send(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Agent-Bridge');
    }
    this.ws.send(JSON.stringify(data));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected) {
        this.send({ type: 'heartbeat' });
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async registerWithRest(): Promise<AgentInfo> {
    const url = `${this.serverUrl}/agents/register`;
    const body = JSON.stringify({
      name: this.agentName,
      type: this.agentType,
      capabilities: ['general'],
      metadata: { client: 'vscode-extension' }
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const json = await response.json() as { agent: AgentInfo };
    return json.agent;
  }

  async fetchAgents(): Promise<AgentInfo[]> {
    const response = await fetch(`${this.serverUrl}/agents`);
    const json = await response.json() as { agents: AgentInfo[] };
    return json.agents;
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
