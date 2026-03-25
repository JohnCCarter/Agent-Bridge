import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import app, { clearEventHistory, stopBackgroundTimers, server as bridgeServer } from './index';
import { clearContractsStore } from './contracts';
import { clearAgentsStore } from './agent-registry';

// Stop the global message-prune timer so Jest exits cleanly
afterAll(() => stopBackgroundTimers());

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeout = 2000, interval = 25): Promise<void> {
  const start = Date.now();
  while (true) {
    if (condition()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

function wsConnect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function wsSend(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function wsReceive(ws: WebSocket): Promise<object> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => {
      try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
    });
    ws.once('error', reject);
  });
}

// Collect all messages from a WebSocket into an array
function collectMessages(ws: WebSocket): object[] {
  const msgs: object[] = [];
  ws.on('message', (raw) => {
    try { msgs.push(JSON.parse(raw.toString())); } catch { /* skip */ }
  });
  return msgs;
}

describe('Agent Registry – REST API', () => {
  let srv: http.Server;
  let port: number;

  beforeAll(done => {
    srv = bridgeServer.listen(0, () => {
      port = (srv.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(done => { srv.close(done); });

  beforeEach(() => {
    clearEventHistory();
    clearContractsStore();
    clearAgentsStore();
  });

  it('registers a new agent', async () => {
    const res = await request(app)
      .post('/agents/register')
      .send({ name: 'alpha', type: 'tester', capabilities: ['testing'] })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.agent.name).toBe('alpha');
    expect(res.body.agent.status).toBe('online');
  });

  it('re-registering same agent updates it and keeps it online', async () => {
    await request(app).post('/agents/register').send({ name: 'alpha', type: 'v1' }).expect(201);
    const res = await request(app).post('/agents/register').send({ name: 'alpha', type: 'v2' }).expect(201);
    expect(res.body.agent.type).toBe('v2');
    expect(res.body.agent.status).toBe('online');
  });

  it('lists all registered agents', async () => {
    await request(app).post('/agents/register').send({ name: 'alpha', type: 't' }).expect(201);
    await request(app).post('/agents/register').send({ name: 'beta', type: 't' }).expect(201);
    const res = await request(app).get('/agents').expect(200);
    expect(res.body.agents).toHaveLength(2);
    const names = res.body.agents.map((a: { name: string }) => a.name);
    expect(names).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('gets a single agent by name', async () => {
    await request(app).post('/agents/register').send({ name: 'gamma', type: 'ai' }).expect(201);
    const res = await request(app).get('/agents/gamma').expect(200);
    expect(res.body.agent.name).toBe('gamma');
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).get('/agents/nonexistent').expect(404);
    expect(res.body.success).toBe(false);
  });

  it('updates agent status via PATCH', async () => {
    await request(app).post('/agents/register').send({ name: 'delta', type: 'ai' }).expect(201);
    const res = await request(app)
      .patch('/agents/delta/status')
      .send({ status: 'busy' })
      .expect(200);
    expect(res.body.agent.status).toBe('busy');
  });

  it('returns 404 when updating status of unknown agent', async () => {
    await request(app).patch('/agents/ghost/status').send({ status: 'online' }).expect(404);
  });

  it('rejects invalid status values', async () => {
    await request(app).post('/agents/register').send({ name: 'delta', type: 'ai' }).expect(201);
    await request(app).patch('/agents/delta/status').send({ status: 'invalid' }).expect(400);
  });

  it('deregisters an agent', async () => {
    await request(app).post('/agents/register').send({ name: 'epsilon', type: 'ai' }).expect(201);
    await request(app).delete('/agents/epsilon').expect(200);
    const res = await request(app).get('/agents/epsilon').expect(200);
    expect(res.body.agent.status).toBe('offline');
  });

  it('returns 404 when deregistering unknown agent', async () => {
    await request(app).delete('/agents/phantom').expect(404);
  });

  it('rejects registration with missing name', async () => {
    await request(app).post('/agents/register').send({ type: 'ai' }).expect(400);
  });
});

describe('Lock Ownership', () => {
  beforeEach(() => { clearEventHistory(); });

  it('rejects renew_lock from a non-holder', async () => {
    await request(app).post('/lock_resource').send({ resource: 'file.ts', holder: 'agent-a', ttl: 60 }).expect(201);
    const res = await request(app).post('/renew_lock').send({ resource: 'file.ts', holder: 'agent-b', ttl: 120 }).expect(403);
    expect(res.body.error).toMatch(/holder/);
    await request(app).delete('/unlock_resource/file.ts?holder=agent-a').expect(200);
  });

  it('rejects unlock_resource from a non-holder', async () => {
    await request(app).post('/lock_resource').send({ resource: 'file2.ts', holder: 'owner', ttl: 60 }).expect(201);
    const res = await request(app).delete('/unlock_resource/file2.ts?holder=intruder').expect(403);
    expect(res.body.error).toMatch(/holder/);
    await request(app).delete('/unlock_resource/file2.ts?holder=owner').expect(200);
  });

  it('allows the holder to renew and release', async () => {
    await request(app).post('/lock_resource').send({ resource: 'myfile.ts', holder: 'owner', ttl: 60 }).expect(201);
    await request(app).post('/renew_lock').send({ resource: 'myfile.ts', holder: 'owner', ttl: 90 }).expect(200);
    await request(app).delete('/unlock_resource/myfile.ts?holder=owner').expect(200);
  });
});

describe('WebSocket – agent communication', () => {
  let srv: http.Server;
  let port: number;

  beforeAll(done => {
    srv = bridgeServer.listen(0, () => {
      port = (srv.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(done => { srv.close(done); });

  beforeEach(() => {
    clearEventHistory();
    clearAgentsStore();
  });

  it('accepts a connection and returns registered confirmation', async () => {
    const ws = await wsConnect(port);
    const p = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'agent-x' });
    const msg = await p as { type: string; agent: string };
    expect(msg.type).toBe('registered');
    expect(msg.agent).toBe('agent-x');
    ws.close();
  });

  it('routes a direct message between two agents', async () => {
    const ws1 = await wsConnect(port);
    const ws2 = await wsConnect(port);

    // Register both
    const r1 = wsReceive(ws1);
    wsSend(ws1, { type: 'register', from: 'sender' });
    await r1;

    const r2 = wsReceive(ws2);
    wsSend(ws2, { type: 'register', from: 'receiver' });
    await r2;

    // ws2 should receive agent.joined for 'sender' (already done) – flush by waiting
    await sleep(50);

    // Collect incoming on ws2
    const incoming: object[] = collectMessages(ws2);

    wsSend(ws1, { type: 'message', from: 'sender', to: 'receiver', payload: { hello: 'world' } });

    await waitFor(() => incoming.length > 0);
    const dm = incoming[0] as { type: string; from: string; payload: { hello: string } };
    expect(dm.type).toBe('message');
    expect(dm.from).toBe('sender');
    expect(dm.payload).toEqual({ hello: 'world' });

    ws1.close();
    ws2.close();
  });

  it('broadcasts a message to all other agents', async () => {
    const wsA = await wsConnect(port);
    const wsB = await wsConnect(port);
    const wsC = await wsConnect(port);

    await Promise.all([
      (async () => { const p = wsReceive(wsA); wsSend(wsA, { type: 'register', from: 'a' }); await p; })(),
      (async () => { const p = wsReceive(wsB); wsSend(wsB, { type: 'register', from: 'b' }); await p; })(),
      (async () => { const p = wsReceive(wsC); wsSend(wsC, { type: 'register', from: 'c' }); await p; })(),
    ]);

    await sleep(50); // let agent.joined events settle

    const receivedB: object[] = collectMessages(wsB);
    const receivedC: object[] = collectMessages(wsC);
    const receivedA: object[] = collectMessages(wsA);

    wsSend(wsA, { type: 'broadcast', from: 'a', payload: 'hello all' });

    await waitFor(() => receivedB.some((m: any) => m.type === 'broadcast'));
    await waitFor(() => receivedC.some((m: any) => m.type === 'broadcast'));

    // sender should NOT receive its own broadcast
    await sleep(50);
    expect(receivedA.some((m: any) => m.type === 'broadcast')).toBe(false);

    wsA.close();
    wsB.close();
    wsC.close();
  });

  it('notifies peers when an agent disconnects', async () => {
    const wsA = await wsConnect(port);
    const wsB = await wsConnect(port);

    const rA = wsReceive(wsA); wsSend(wsA, { type: 'register', from: 'peer-a' }); await rA;
    const rB = wsReceive(wsB); wsSend(wsB, { type: 'register', from: 'peer-b' }); await rB;
    await sleep(50);

    const eventsA: object[] = collectMessages(wsA);
    wsB.close();

    await waitFor(() => eventsA.some((m: any) => m.type === 'agent.left'));
    const leftMsg = eventsA.find((m: any) => m.type === 'agent.left') as { agent: string } | undefined;
    expect(leftMsg?.agent).toBe('peer-b');

    wsA.close();
  });

  it('returns an error for unknown message types', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws); wsSend(ws, { type: 'register', from: 'err-agent' }); await r;

    const errP = wsReceive(ws);
    wsSend(ws, { type: 'unknown_type' });
    const errMsg = await errP as { type: string; error: string };
    expect(errMsg.type).toBe('error');

    ws.close();
  });

  it('returns an error for invalid JSON', done => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => {
      ws.once('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        expect(msg.type).toBe('error');
        ws.close();
        done();
      });
      ws.send('not-valid-json');
    });
  });

  it('second register from same name replaces the first connection', async () => {
    const ws1 = await wsConnect(port);
    const r1 = wsReceive(ws1); wsSend(ws1, { type: 'register', from: 'duplicate' }); await r1;

    const ws2 = await wsConnect(port);
    const r2 = wsReceive(ws2); wsSend(ws2, { type: 'register', from: 'duplicate' }); await r2;

    // ws1 should be closed by the server
    await waitFor(() => ws1.readyState === WebSocket.CLOSED);
    expect(ws1.readyState).toBe(WebSocket.CLOSED);

    ws2.close();
  });

  it('heartbeat responds with heartbeat.ack', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws); wsSend(ws, { type: 'register', from: 'hb-agent' }); await r;

    const ack = wsReceive(ws);
    wsSend(ws, { type: 'heartbeat' });
    const ackMsg = await ack as { type: string };
    expect(ackMsg.type).toBe('heartbeat.ack');

    ws.close();
  });
});

// ── Integration: unified message delivery ─────────────────────────────────────
describe('Unified message delivery – WS ↔ REST bridge', () => {
  let srv: http.Server;
  let port: number;

  beforeAll(done => {
    srv = bridgeServer.listen(0, () => {
      port = (srv.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(done => { srv.close(done); });

  beforeEach(() => {
    clearEventHistory();
    clearContractsStore();
    clearAgentsStore();
  });

  // ── Scenario 1 ──────────────────────────────────────────────────────────────
  it('REST publish delivers immediately via WS when recipient is online', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'bob' });
    await r; // 'registered'

    await sleep(30); // let agent.joined settle

    const incoming = collectMessages(ws);

    // Alice publishes to Bob via REST
    const res = await request(app)
      .post('/publish_message')
      .send({ recipient: 'bob', content: 'hello from REST', sender: 'alice' })
      .expect(201);

    expect(res.body.success).toBe(true);

    // Bob should receive it over WS without polling
    await waitFor(() => incoming.some((m: any) => m.type === 'message'));
    const msg = incoming.find((m: any) => m.type === 'message') as any;
    expect(msg.from).toBe('alice');
    expect(msg.payload).toBe('hello from REST');
    expect(msg.messageId).toBe(res.body.messageId);

    ws.close();
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────────────
  it('WS message to offline agent is queued and delivered on reconnect', async () => {
    // Sender connects and registers
    const wsSender = await wsConnect(port);
    const r1 = wsReceive(wsSender);
    wsSend(wsSender, { type: 'register', from: 'sender' });
    await r1;

    await sleep(30);

    // Send to 'offline-agent' who is not connected yet
    const senderIncoming = collectMessages(wsSender);
    wsSend(wsSender, { type: 'message', from: 'sender', to: 'offline-agent', payload: 'queued hello' });

    // Sender should receive 'message.queued' confirmation
    await waitFor(() => senderIncoming.some((m: any) => m.type === 'message.queued'));
    const queued = senderIncoming.find((m: any) => m.type === 'message.queued') as any;
    expect(queued.to).toBe('offline-agent');
    expect(queued.reason).toBe('recipient offline');

    // Now offline-agent comes online
    const wsReceiver = await wsConnect(port);
    const receiverIncoming = collectMessages(wsReceiver);
    const r2 = wsReceive(wsReceiver);
    wsSend(wsReceiver, { type: 'register', from: 'offline-agent' });
    await r2; // 'registered'

    // Should receive the queued message immediately on reconnect (drain)
    await waitFor(() => receiverIncoming.some((m: any) => m.type === 'message'));
    const delivered = receiverIncoming.find((m: any) => m.type === 'message') as any;
    expect(delivered.from).toBe('sender');
    expect(delivered.payload).toBe('queued hello');

    wsSender.close();
    wsReceiver.close();
  });

  // ── Scenario 3 ──────────────────────────────────────────────────────────────
  it('WS-only agent is auto-registered in the agent registry', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'ws-only-agent' });
    await r;

    await sleep(30);

    // Should appear in REST registry without ever calling /agents/register
    const res = await request(app).get('/agents').expect(200);
    const names = res.body.agents.map((a: any) => a.name);
    expect(names).toContain('ws-only-agent');

    const agent = res.body.agents.find((a: any) => a.name === 'ws-only-agent');
    expect(agent.status).toBe('online');

    ws.close();
  });
});

// ── Capability routing (WS) ───────────────────────────────────────────────────

describe('Capability-based WS routing', () => {
  let srv: http.Server;
  let port: number;

  beforeAll(done => {
    srv = bridgeServer.listen(0, () => {
      port = (srv.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(done => { srv.close(done); });

  beforeEach(() => {
    clearEventHistory();
    clearContractsStore();
    clearAgentsStore();
  });

  it('WS register with capabilities stores them in the registry', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'cap-agent', capabilities: ['code-review', 'testing'] });
    await r;

    await sleep(30);

    const res = await request(app).get('/agents/cap-agent').expect(200);
    expect(res.body.agent.capabilities).toEqual(
      expect.arrayContaining(['code-review', 'testing'])
    );
    ws.close();
  });

  it('capability message is delivered immediately to online agent via WS', async () => {
    const agentWs = await wsConnect(port);
    const agentMsgs = collectMessages(agentWs);
    const r = wsReceive(agentWs);
    wsSend(agentWs, { type: 'register', from: 'cap-worker', capabilities: ['data-processing'] });
    await r;
    await sleep(30);

    // Publish via REST with capability routing
    const pub = await request(app)
      .post('/publish_message')
      .send({ capability: 'data-processing', content: 'process this', sender: 'orchestrator' })
      .expect(201);

    expect(pub.body.capability).toBe('data-processing');

    // Agent should receive it over WS
    await waitFor(() => agentMsgs.some((m: any) => m.type === 'message'), 2000);
    const delivered = agentMsgs.find((m: any) => m.type === 'message') as any;
    expect(delivered).toBeDefined();
    expect(delivered.payload).toBe('process this');
    expect(delivered.from).toBe('orchestrator');

    agentWs.close();
  });

  it('capability message queued when no agent online, delivered on reconnect', async () => {
    // Publish before any capable agent connects
    await request(app)
      .post('/publish_message')
      .send({ capability: 'delayed-cap', content: 'wait for me', sender: 'user' })
      .expect(201);

    // Register agent with the capability – should drain the queue
    const ws = await wsConnect(port);
    const incoming = collectMessages(ws);
    const r = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'late-agent', capabilities: ['delayed-cap'] });
    await r;

    await waitFor(() => incoming.some((m: any) => m.type === 'message'), 2000);
    const msg = incoming.find((m: any) => m.type === 'message') as any;
    expect(msg.payload).toBe('wait for me');

    ws.close();
  });

  it('WS thought event is accepted and triggers thought.ack', async () => {
    const ws = await wsConnect(port);
    const r = wsReceive(ws);
    wsSend(ws, { type: 'register', from: 'thinking-agent', capabilities: [] });
    await r;

    const ackP = wsReceive(ws);
    wsSend(ws, {
      type: 'thought',
      payload: { reasoning: 'Evaluating options…', phase: 'planning', progress: 0.5 }
    });
    const ack = await ackP as any;
    expect(ack.type).toBe('thought.ack');
    expect(ack.id).toBeTruthy();

    ws.close();
  });
});
