import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  contractCreateSchema,
  contractUpdateSchema,
  contractVoteSchema,
  createContract,
  getContract,
  listContracts,
  updateContract,
  serializeContract,
  attachMessageToContract,
  flushContractPersistence,
  createSubContract,
  checkOverdueContracts,
  voteOnContract,
} from './contracts';
import {
  agentRegisterSchema,
  registerAgent,
  deregisterAgent,
  heartbeatAgent,
  setAgentStatus,
  getAgent,
  listAgents,
  listAgentsByCapability,
  serializeAgent,
  AgentStatus
} from './agent-registry';
import path from 'path';
import {
  dbSaveMessage,
  dbDeleteMessage,
  dbUpdateMessageClaim,
  dbLoadAllMessages,
  dbClearMessages,
  dbSaveDlqEntry,
  dbDeleteDlqEntry,
  dbLoadAllDlqEntries,
  dbClearDlq,
  dbMemorySet,
  dbMemoryGet,
  dbMemoryList,
  dbMemoryDelete,
  dbMemoryDeleteAgent,
  dbMemoryPruneExpired,
  dbMemoryClearAll,
} from './db';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// WebSocket server for real-time agent-to-agent communication
const WS_MAX_PAYLOAD = 64 * 1024;      // 64 KB per frame
const WS_HEARTBEAT_INTERVAL_MS = 30_000;
const WS_HEARTBEAT_TIMEOUT_MS = 10_000; // eslint-disable-line @typescript-eslint/no-unused-vars
const MAX_AGENT_CONNECTIONS = 200;       // Max concurrent WebSocket agents
const AGENT_NAME_MAX_LEN = 64;          // Max characters in an agent name
const AGENT_NAME_RE = /^[\w\-:.@]+$/;   // Allowed characters in agent names
const MAX_UNACKED_MESSAGES = 10_000;    // Hard cap on unacknowledged messages per recipient
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // Unacknowledged messages expire after 24 h
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000; // Explicitly claimed work re-queues after 5 min if not ACKed

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_MAX_PAYLOAD });

// Map from agentName → WebSocket connection
const agentSockets = new Map<string, WebSocket>();

interface WsEnvelope {
  type: 'register' | 'message' | 'broadcast' | 'heartbeat' | 'status' | 'thought';
  from?: string;
  to?: string;
  capability?: string;    // capability-based routing in 'message'
  capabilities?: string[]; // advertised capabilities in 'register'
  payload?: unknown;
}

interface AgentThought {
  id: string;
  agent: string;
  timestamp: string;
  phase?: string;
  progress?: number;   // 0.0 – 1.0
  reasoning: string;
}

function sendWs(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastWs(data: unknown, exclude?: WebSocket): void {
  for (const client of agentSockets.values()) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      sendWs(client, data);
    }
  }
}

wss.on('connection', (ws: WebSocket) => {
  let connectedAgentName: string | null = null;
  let alive = true;

  // Server-side heartbeat: ping every 30 s, close if no pong within 10 s
  const pingInterval = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, WS_HEARTBEAT_INTERVAL_MS);

  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw: Buffer) => {
    let envelope: WsEnvelope;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      sendWs(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (envelope.type) {
      case 'register': {
        const name = String(envelope.from || '').trim();
        if (!name) {
          sendWs(ws, { type: 'error', error: 'from (agent name) required for register' });
          return;
        }
        if (name.length > AGENT_NAME_MAX_LEN) {
          sendWs(ws, { type: 'error', error: `agent name must be ${AGENT_NAME_MAX_LEN} characters or fewer` });
          return;
        }
        if (!AGENT_NAME_RE.test(name)) {
          sendWs(ws, { type: 'error', error: 'agent name may only contain letters, digits, _ - : . @' });
          return;
        }
        if (!agentSockets.has(name) && agentSockets.size >= MAX_AGENT_CONNECTIONS) {
          sendWs(ws, { type: 'error', error: 'server at maximum agent capacity' });
          ws.close(1013, 'server full');
          return;
        }
        // Close any existing socket for this agent
        const existing = agentSockets.get(name);
        if (existing && existing !== ws) {
          existing.close(1000, 'replaced by new connection');
        }
        connectedAgentName = name;
        agentSockets.set(name, ws);
        // Capabilities from the register envelope (optional, backwards-compatible)
        const wsCaps = Array.isArray(envelope.capabilities)
          ? (envelope.capabilities as unknown[]).map(c => String(c)).filter(c => c.length > 0 && c.length <= 64)
          : [];
        // Sync with agent registry: heartbeat + update capabilities if known, else register
        if (!heartbeatAgent(name)) {
          registerAgent({ name, type: 'ws-agent', capabilities: wsCaps });
        } else if (wsCaps.length > 0) {
          // Re-register to update capabilities on reconnect
          registerAgent({ name, type: 'ws-agent', capabilities: wsCaps });
        }
        sendWs(ws, { type: 'registered', agent: name, peers: Array.from(agentSockets.keys()).filter(k => k !== name) });
        broadcastWs({ type: 'agent.joined', agent: name }, ws);
        pushEvent('agent.connected', { agent: name, capabilities: wsCaps });
        // Deliver any messages that arrived while this agent was offline
        drainQueuedMessages(name);
        break;
      }
      case 'message': {
        const to = String(envelope.to || '').trim();
        const capability = String(envelope.capability || '').trim();
        const from = connectedAgentName || String(envelope.from || '').trim();
        if (!to && !capability) {
          sendWs(ws, { type: 'error', error: 'to or capability required for message' });
          return;
        }
        if (!from) {
          sendWs(ws, { type: 'error', error: 'from required for message' });
          return;
        }
        const content = typeof envelope.payload === 'string'
          ? envelope.payload
          : JSON.stringify(envelope.payload ?? '');

        if (capability) {
          // Capability-based routing: deliver to a capable online agent or queue
          const queued = queueMessage(`@cap:${capability}`, content, from);
          if (!queued.ok) {
            sendWs(ws, { type: 'error', error: queued.error });
            break;
          }
          const routed = routeByCapability(capability, queued.message);
          if (!routed) {
            sendWs(ws, { type: 'message.queued', capability, messageId: queued.message.id, reason: 'no capable agent online' });
          }
          pushEvent('message.published', { messageId: queued.message.id, from, capability, delivered: routed });
        } else {
          // Direct name-based routing
          const queued = queueMessage(to, content, from);
          if (!queued.ok) {
            sendWs(ws, { type: 'error', error: queued.error });
            break;
          }
          const wsDelivered = deliverViaWs(to, queued.message);
          if (!wsDelivered) {
            sendWs(ws, { type: 'message.queued', to, messageId: queued.message.id, reason: 'recipient offline' });
          }
          pushEvent('message.published', { messageId: queued.message.id, from, to, delivered: wsDelivered });
        }
        break;
      }
      case 'thought': {
        if (!connectedAgentName) {
          sendWs(ws, { type: 'error', error: 'must register before sending thoughts' });
          break;
        }
        const rawPayload = envelope.payload as Record<string, unknown> | undefined;
        const reasoning = String(rawPayload?.reasoning ?? '').trim();
        if (!reasoning) {
          sendWs(ws, { type: 'error', error: 'reasoning is required in thought payload' });
          break;
        }
        const thought: AgentThought = {
          id: generateId(),
          agent: connectedAgentName,
          timestamp: new Date().toISOString(),
          phase: rawPayload?.phase !== undefined ? String(rawPayload.phase) : undefined,
          progress: typeof rawPayload?.progress === 'number' ? rawPayload.progress : undefined,
          reasoning
        };
        if (!agentThoughts.has(connectedAgentName)) agentThoughts.set(connectedAgentName, []);
        const thoughtList = agentThoughts.get(connectedAgentName)!;
        thoughtList.push(thought);
        if (thoughtList.length > AGENT_THOUGHTS_LIMIT) thoughtList.shift();
        sendWs(ws, { type: 'thought.ack', id: thought.id });
        pushEvent('agent.thought', thought);
        break;
      }
      case 'broadcast': {
        const from = connectedAgentName || String(envelope.from || '').trim();
        broadcastWs({ type: 'broadcast', from, payload: envelope.payload, timestamp: new Date().toISOString() }, ws);
        pushEvent('ws.broadcast', { from });
        break;
      }
      case 'heartbeat': {
        if (connectedAgentName) {
          heartbeatAgent(connectedAgentName);
        }
        sendWs(ws, { type: 'heartbeat.ack', timestamp: new Date().toISOString() });
        break;
      }
      case 'status': {
        if (connectedAgentName) {
          const rawStatus = String((envelope.payload as { status?: string })?.status || '').trim();
          const VALID_STATUSES: AgentStatus[] = ['online', 'offline', 'busy'];
          if (!VALID_STATUSES.includes(rawStatus as AgentStatus)) {
            sendWs(ws, { type: 'error', error: `Invalid status "${rawStatus}". Must be one of: ${VALID_STATUSES.join(', ')}` });
            break;
          }
          const status = rawStatus as AgentStatus;
          const ok = setAgentStatus(connectedAgentName, status);
          broadcastWs({ type: 'agent.status', agent: connectedAgentName, status }, ws);
          sendWs(ws, { type: 'status.ack', agent: connectedAgentName, status, ok, timestamp: new Date().toISOString() });
        }
        break;
      }
      default:
        sendWs(ws, { type: 'error', error: `Unknown type: ${envelope.type}` });
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (connectedAgentName) {
      // Guard against the reconnection race: if the agent re-registered before
      // this old socket's close event fired, agentSockets already points to the
      // new socket. Only clean up when this socket is still the active one.
      if (agentSockets.get(connectedAgentName) === ws) {
        agentSockets.delete(connectedAgentName);
        deregisterAgent(connectedAgentName);
        broadcastWs({ type: 'agent.left', agent: connectedAgentName });
        pushEvent('agent.disconnected', { agent: connectedAgentName });
      }
    }
  });
});

// Security headers
app.use(helmet());

// CORS – allow same-origin and localhost by default; override via CORS_ORIGIN env
const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));

// ── API Key Authentication ────────────────────────────────────────────────────
// Set API_KEY env var to enable. Accepted as:
//   Authorization: Bearer <key>
//   X-API-Key: <key>
// Skipped entirely when API_KEY is not configured (dev convenience).
const API_KEY = process.env.API_KEY?.trim() || '';

function requireApiKey(req: Request, res: Response, next: () => void): void {
  if (!API_KEY) {
    // Auth not configured – allow through (set API_KEY in production)
    return next();
  }
  const bearerHeader = String(req.headers['authorization'] || '');
  const fromBearer = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7).trim() : '';
  const fromHeader = String(req.headers['x-api-key'] || '').trim();
  // fromQuery is used exclusively for SSE clients (EventSource cannot send headers in browsers).
  // WARNING: this causes the API key to appear in server access logs. Treat logs as sensitive in production.
  const fromQuery = String(req.query?.key || '').trim();
  const provided = fromBearer || fromHeader || fromQuery;

  let authed = false;
  try {
    authed = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY));
  } catch {
    // Buffer lengths differ — key is definitely wrong
  }
  if (!authed) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

// Apply to all API routes (dashboard excluded – it serves static HTML)
app.use('/publish_message', requireApiKey);
app.use('/fetch_messages', requireApiKey);
app.use('/ack_message', requireApiKey);
app.use('/contracts', requireApiKey);
app.use('/lock_resource', requireApiKey);
app.use('/unlock_resource', requireApiKey);
app.use('/renew_lock', requireApiKey);
app.use('/agents', requireApiKey);
app.use('/events', requireApiKey);
app.use('/conversation', requireApiKey);
app.use('/claim_work', requireApiKey);
app.use('/capabilities', requireApiKey);
app.use('/dlq', requireApiKey);
app.use('/traces', requireApiKey);
app.use('/simulate', requireApiKey);

// Rate limiters
const dashboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Core API: 300 requests per minute per IP (generous for local dev)
// Disabled in test environment so performance tests can send bulk requests
const isTestEnv = process.env.NODE_ENV === 'test';
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 0 : 300, // 0 = unlimited in tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please slow down.' },
  skip: () => isTestEnv
});

// Reduce body size limit from 50 MB to something more reasonable
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.use('/api', apiLimiter);
app.use('/publish_message', apiLimiter);
app.use('/fetch_messages', apiLimiter);
app.use('/ack_message', apiLimiter);
app.use('/contracts', apiLimiter);
app.use('/lock_resource', apiLimiter);
app.use('/unlock_resource', apiLimiter);
app.use('/renew_lock', apiLimiter);
app.use('/agents', apiLimiter);
app.use('/conversation', apiLimiter);
app.use('/claim_work', apiLimiter);
app.use('/capabilities', apiLimiter);
app.use('/dlq', apiLimiter);
app.use('/traces', apiLimiter);
app.use('/simulate', apiLimiter);

app.use('/dashboard', dashboardLimiter);
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.get('/dashboard', dashboardLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});

interface Message {
  id: string;
  recipient: string;
  content: string;
  timestamp: Date;
  acknowledged: boolean;
  sender?: string;
  contractId?: string;
  traceId?: string;
  /** Set when message is explicitly claimed via POST /claim_work */
  claimedAt?: Date;
  /** Which capability this message was claimed from (enables re-queue on timeout) */
  claimCapability?: string;
  /** How many times this message has been reclaimed after a timeout */
  reclaimCount?: number;
}

interface DlqEntry {
  id: string;
  reason: 'expired' | 'max_reclaims';
  originalMessage: {
    id: string;
    sender?: string;
    recipient: string;
    content: string;
    timestamp: Date;
    contractId?: string;
    traceId?: string;
  };
  arrivedAt: Date;
  reclaimCount: number;
}

interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  operation: string;
  agentName?: string;
  startedAt: string;
  endedAt?: string;
  attributes: Record<string, unknown>;
}

interface ResourceLock {
  resource: string;
  holder: string;
  ttl: number;
  createdAt: Date;
}

interface BridgeEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: unknown;
}

const MAX_RECLAIM_COUNT = 3; // after this many reclaims, message moves to DLQ

const messagesById = new Map<string, Message>();
const messagesByRecipient = new Map<string, Message[]>();
const unacknowledgedByRecipient = new Map<string, Set<string>>();
const locks: Map<string, ResourceLock> = new Map();

// capability → Set of undelivered messageIds waiting for a capable agent
const capabilityQueues = new Map<string, Set<string>>();

// Dead letter queue – keyed by DLQ entry id
const dlq = new Map<string, DlqEntry>();

// traceId → ordered list of spans
const traceSpans = new Map<string, TraceSpan[]>();

// agent-thought log: agentName → last AGENT_THOUGHTS_LIMIT thoughts
const agentThoughts = new Map<string, AgentThought[]>();
const AGENT_THOUGHTS_LIMIT = 50;

// ── Deadlock detection ────────────────────────────────────────────────────────
// Tracks which resource each agent is currently blocked on (set when a lock
// request fails because the resource is held by another agent, cleared when
// the agent acquires the lock or explicitly gives up).
const waitingFor = new Map<string, string>(); // agentName → resourceName

/**
 * Returns the deadlock cycle as an array of agent names if adding the edge
 * (requester → requestedResource) would create a cycle, otherwise null.
 *
 * The wait-for graph is: requester → holder(requestedResource) → holder(resource
 * holder is waiting for) → ...  A cycle exists when we reach the original requester.
 */
function detectDeadlockCycle(requester: string, requestedResource: string): string[] | null {
  const cycle: string[] = [requester];
  const visited = new Set<string>();
  let current = requester;

  while (true) {
    const resource = current === requester ? requestedResource : waitingFor.get(current);
    if (!resource) return null;

    const lock = locks.get(resource);
    if (!lock || isLockExpired(lock)) return null;

    const holder = lock.holder;
    if (holder === requester) {
      // Closed the cycle back to the original requester
      cycle.push(holder);
      return cycle;
    }
    if (visited.has(holder)) return null; // visited non-requester node → no cycle through requester
    visited.add(holder);
    cycle.push(holder);
    current = holder;
  }
}

const CONVERSATION_HISTORY_LIMIT = 1000;

// Ordered circular buffer of published messages for the /conversation endpoint
const conversationHistory: (Message | undefined)[] = new Array(CONVERSATION_HISTORY_LIMIT).fill(undefined);
let conversationHistoryIndex = 0;   // next write position
let conversationHistorySize = 0;    // number of messages stored

function pushConversationHistory(msg: Message): void {
  conversationHistory[conversationHistoryIndex] = msg;
  conversationHistoryIndex = (conversationHistoryIndex + 1) % CONVERSATION_HISTORY_LIMIT;
  if (conversationHistorySize < CONVERSATION_HISTORY_LIMIT) conversationHistorySize++;
}

function getRecentConversation(limit: number): Message[] {
  const count = Math.min(limit, conversationHistorySize);
  const result: Message[] = [];
  const startOffset = (conversationHistoryIndex - count + CONVERSATION_HISTORY_LIMIT) % CONVERSATION_HISTORY_LIMIT;
  for (let i = 0; i < count; i++) {
    const msg = conversationHistory[(startOffset + i) % CONVERSATION_HISTORY_LIMIT];
    if (msg) result.push(msg);
  }
  return result;
}

// ── DLQ helpers ───────────────────────────────────────────────────────────────
function moveToDlq(msg: Message, reason: 'expired' | 'max_reclaims'): void {
  const entry: DlqEntry = {
    id: generateId(),
    reason,
    originalMessage: {
      id: msg.id,
      sender: msg.sender,
      recipient: msg.recipient,
      content: msg.content,
      timestamp: msg.timestamp,
      contractId: msg.contractId,
      traceId: msg.traceId,
    },
    arrivedAt: new Date(),
    reclaimCount: msg.reclaimCount ?? 0,
  };
  dlq.set(entry.id, entry);
  dbSaveDlqEntry({
    id: entry.id,
    reason,
    msgId: msg.id,
    sender: msg.sender,
    recipient: msg.recipient,
    content: msg.content,
    msgTimestamp: msg.timestamp.toISOString(),
    contractId: msg.contractId,
    traceId: msg.traceId,
    reclaimCount: entry.reclaimCount,
    arrivedAt: entry.arrivedAt.toISOString(),
  });
  pushEvent('message.dlq', { dlqId: entry.id, reason, originalMessageId: msg.id, recipient: msg.recipient });
}

// ── Tracing helpers ───────────────────────────────────────────────────────────
function createSpan(
  traceId: string,
  operation: string,
  attributes: Record<string, unknown> = {},
  parentSpanId?: string,
  agentName?: string,
): TraceSpan {
  const span: TraceSpan = {
    spanId: generateId(),
    traceId,
    parentSpanId,
    operation,
    agentName,
    startedAt: new Date().toISOString(),
    attributes,
  };
  if (!traceSpans.has(traceId)) traceSpans.set(traceId, []);
  traceSpans.get(traceId)!.push(span);
  return span;
}

function closeSpan(span: TraceSpan): void {
  span.endedAt = new Date().toISOString();
}

// ── Startup: restore persisted messages + DLQ into memory ────────────────────
(function loadPersistedMessages() {
  const rows = dbLoadAllMessages();
  for (const row of rows) {
    const msg: Message = {
      id: row.id,
      recipient: row.recipient,
      content: row.content,
      timestamp: new Date(row.timestamp),
      acknowledged: false,
      sender: row.sender,
      contractId: row.contractId,
      traceId: row.traceId,
      claimedAt: row.claimedAt ? new Date(row.claimedAt) : undefined,
      claimCapability: row.claimCapability,
      reclaimCount: row.reclaimCount ?? 0,
    };
    messagesById.set(msg.id, msg);
    if (!messagesByRecipient.has(msg.recipient)) messagesByRecipient.set(msg.recipient, []);
    messagesByRecipient.get(msg.recipient)!.push(msg);
    if (!unacknowledgedByRecipient.has(msg.recipient)) unacknowledgedByRecipient.set(msg.recipient, new Set());
    unacknowledgedByRecipient.get(msg.recipient)!.add(msg.id);

    // Re-queue capability messages so they can be claimed / drained
    if (msg.recipient.startsWith('@cap:') && !msg.claimedAt) {
      const cap = msg.recipient.slice(5);
      if (!capabilityQueues.has(cap)) capabilityQueues.set(cap, new Set());
      capabilityQueues.get(cap)!.add(msg.id);
    }
  }
  if (rows.length > 0) console.log(`[startup] Restored ${rows.length} unacknowledged message(s) from DB`);

  // Restore DLQ
  const dlqRows = dbLoadAllDlqEntries();
  for (const row of dlqRows) {
    dlq.set(row.id, {
      id: row.id,
      reason: row.reason as 'expired' | 'max_reclaims',
      originalMessage: {
        id: row.msgId,
        sender: row.sender,
        recipient: row.recipient,
        content: row.content,
        timestamp: new Date(row.msgTimestamp),
        contractId: row.contractId,
        traceId: row.traceId,
      },
      arrivedAt: new Date(row.arrivedAt),
      reclaimCount: row.reclaimCount,
    });
  }
  if (dlqRows.length > 0) console.log(`[startup] Restored ${dlqRows.length} DLQ entry/entries from DB`);
})();

// ── Message TTL pruning ───────────────────────────────────────────────────────
function pruneExpiredMessages(): void {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  for (const [id, msg] of messagesById) {
    if (!msg.acknowledged && msg.timestamp.getTime() < cutoff) {
      moveToDlq(msg, 'expired');
      messagesById.delete(id);
      dbDeleteMessage(id);
      const recipientSet = unacknowledgedByRecipient.get(msg.recipient);
      if (recipientSet) {
        recipientSet.delete(id);
        if (recipientSet.size === 0) unacknowledgedByRecipient.delete(msg.recipient);
      }
      const recipientArr = messagesByRecipient.get(msg.recipient);
      if (recipientArr) {
        const idx = recipientArr.findIndex(m => m.id === id);
        if (idx !== -1) recipientArr.splice(idx, 1);
        if (recipientArr.length === 0) messagesByRecipient.delete(msg.recipient);
      }
    }
  }
}

// Run message TTL pruning every 10 minutes; unref so it never prevents exit
const messagePruneTimer = setInterval(() => {
  try { pruneExpiredMessages(); } catch (err) {
    console.error('[message-prune] Error during TTL pruning:', err);
  }
}, 10 * 60 * 1000);
messagePruneTimer.unref();

/**
 * Finds explicitly claimed messages (via POST /claim_work) that have not been
 * ACKed within CLAIM_TIMEOUT_MS and returns them to the capability queue.
 * This protects against agents that crash after claiming but before processing.
 */
function sweepStaleClaims(): void {
  const cutoff = Date.now() - CLAIM_TIMEOUT_MS;
  for (const [id, msg] of messagesById) {
    if (msg.acknowledged || !msg.claimedAt || !msg.claimCapability) continue;
    if (msg.claimedAt.getTime() > cutoff) continue; // not yet timed out

    const prevClaimant = msg.recipient;
    const cap = msg.claimCapability;

    // Remove from previous claimant's indexes
    const prevUnacked = unacknowledgedByRecipient.get(prevClaimant);
    if (prevUnacked) {
      prevUnacked.delete(id);
      if (prevUnacked.size === 0) unacknowledgedByRecipient.delete(prevClaimant);
    }
    const prevMsgs = messagesByRecipient.get(prevClaimant);
    if (prevMsgs) {
      const idx = prevMsgs.findIndex(m => m.id === id);
      if (idx !== -1) prevMsgs.splice(idx, 1);
      if (prevMsgs.length === 0) messagesByRecipient.delete(prevClaimant);
    }

    // Increment reclaim count; send to DLQ if exhausted
    msg.reclaimCount = (msg.reclaimCount ?? 0) + 1;
    if (msg.reclaimCount >= MAX_RECLAIM_COUNT) {
      moveToDlq(msg, 'max_reclaims');
      messagesById.delete(id);
      dbDeleteMessage(id);
      console.log(`[claim-sweep] Message ${id} moved to DLQ after ${msg.reclaimCount} reclaims`);
      continue;
    }

    // Reset claim state and re-address to capability placeholder
    msg.claimedAt = undefined;
    msg.claimCapability = undefined;
    msg.recipient = `@cap:${cap}`;
    dbUpdateMessageClaim(id, msg.recipient, null, null, msg.reclaimCount);

    // Re-index under capability placeholder for TTL pruning
    if (!unacknowledgedByRecipient.has(msg.recipient)) unacknowledgedByRecipient.set(msg.recipient, new Set());
    unacknowledgedByRecipient.get(msg.recipient)!.add(id);
    if (!messagesByRecipient.has(msg.recipient)) messagesByRecipient.set(msg.recipient, []);
    messagesByRecipient.get(msg.recipient)!.push(msg);

    // Put back in capability queue – delivered on next agent connect or claim
    if (!capabilityQueues.has(cap)) capabilityQueues.set(cap, new Set());
    capabilityQueues.get(cap)!.add(id);

    pushEvent('work.reclaimed', { capability: cap, messageId: id, previousClaimant: prevClaimant, reclaimCount: msg.reclaimCount });
    console.log(`[claim-sweep] Reclaimed stale claim: ${id} (capability: ${cap}, reclaim #${msg.reclaimCount})`);
  }
}

// Sweep stale claims every minute; unref so it never prevents exit
const claimSweepTimer = setInterval(() => {
  try { sweepStaleClaims(); } catch (err) {
    console.error('[claim-sweep] Error:', err);
  }
}, 60_000);
claimSweepTimer.unref();

// Contract SLA check every minute – fires contract.overdue SSE events
// pushEvent is defined below; the closure captures it at runtime so forward reference is fine.
const slaCheckTimer = setInterval(() => {
  try {
    const violations = checkOverdueContracts();
    for (const v of violations) {
      pushEvent('contract.overdue', {
        contractId: v.contractId,
        title: v.title,
        status: v.status,
        dueAt: v.dueAt.toISOString(),
        overdueMs: v.overdueMs,
      });
    }
  } catch (err) {
    console.error('[sla-check] Error:', err);
  }
}, 60_000);
slaCheckTimer.unref();

const eventClients = new Set<Response>();
const eventHistory: BridgeEvent[] = [];
let eventHistoryIndex = 0;
const EVENT_HISTORY_LIMIT = 100;
const LOCK_CLEANUP_INTERVAL_MS = 30_000;
let lockCleanupTimer: NodeJS.Timeout | null = null;

const publishMessageSchema = z.object({
  recipient: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
  content: z.string().min(1),
  sender: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
  traceId: z.string().optional(),
  contract: contractCreateSchema.optional()
}).superRefine((messageData, ctx) => {
  if (!messageData.recipient && !messageData.capability) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either recipient or capability',
      path: ['recipient']
    });
  }
  if (messageData.recipient && messageData.capability) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either recipient or capability, not both',
      path: ['capability']
    });
  }
  if (messageData.contract && messageData.contractId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either contract or contractId, not both',
      path: ['contract']
    });
  }
});

const ackMessageSchema = z.object({
  ids: z.array(z.string())
});

const lockResourceSchema = z.object({
  resource: z.string().min(1),
  holder: z.string().min(1),
  ttl: z.number().positive()
});

/**
 * Sends a consistent JSON error response for API handlers.
 */
function sendError(res: Response, status: number, error: string, details?: unknown): void {
  const payload: Record<string, unknown> = { success: false, error };
  if (details !== undefined) {
    payload.details = details;
  }
  res.status(status).json(payload);
}

/**
 * Handles errors in Express route handlers with consistent error response format.
 * Specifically handles Zod validation errors and generic errors.
 */
function handleRouteError(error: unknown, res: Response): void {
  if (error instanceof z.ZodError) {
    sendError(res, 400, 'Invalid request data', error.errors);
  } else if (error instanceof Error && error.message.startsWith('Invalid status transition')) {
    sendError(res, 422, error.message);
  } else {
    sendError(res, 500, 'Internal server error');
  }
}

const renewLockSchema = z.object({
  resource: z.string().min(1),
  holder: z.string().min(1),
  ttl: z.number().positive()
});

const contractIdParamSchema = z.object({
  id: z.string().min(1)
});

const claimWorkSchema = z.object({
  capability: z.string().min(1),
  claimant: z.string().min(1)
});

const agentThoughtSchema = z.object({
  reasoning: z.string().min(1).max(4000),
  phase: z.string().max(64).optional(),
  progress: z.number().min(0).max(1).optional()
});

const memoryKeySchema = z.string().min(1).max(128).regex(/^[\w\-.:]+$/, 'Key must be alphanumeric with - . :');
const memorySetSchema = z.object({
  value: z.unknown(),
  ttlSeconds: z.number().int().positive().optional(),
}).strict();

function generateId(): string {
  return crypto.randomUUID();
}

function isLockExpired(lock: ResourceLock): boolean {
  const now = Date.now();
  const expiresAt = lock.createdAt.getTime() + (lock.ttl * 1000);
  return now > expiresAt;
}

/**
 * Calculates the expiration date for a resource lock.
 */
function getLockExpiryDate(lock: ResourceLock): Date {
  return new Date(lock.createdAt.getTime() + (lock.ttl * 1000));
}

function cleanExpiredLocks(): void {
  for (const [resource, lock] of locks.entries()) {
    if (isLockExpired(lock)) {
      locks.delete(resource);
      pushEvent('lock.expired', {
        resource,
        holder: lock.holder
      });
    }
  }
}

function ensureLockCleanupTimer(): void {
  if (lockCleanupTimer) {
    return;
  }

  lockCleanupTimer = setInterval(() => {
    try {
      cleanExpiredLocks();
    } catch (err) {
      console.error('[lock-cleanup] Error during expired lock cleanup:', err);
    }
    if (locks.size === 0 && lockCleanupTimer) {
      clearInterval(lockCleanupTimer);
      lockCleanupTimer = null;
    }
  }, LOCK_CLEANUP_INTERVAL_MS);
  lockCleanupTimer.unref();
}

// ── Unified message storage ───────────────────────────────────────────────────
// Stores a message in the persistent queue (messagesById + indexes).
// Returns null and a 429 reason string when the recipient queue is full.
function queueMessage(
  recipient: string,
  content: unknown,
  sender?: string,
  contractId?: string,
  traceId?: string,
): { ok: true; message: Message } | { ok: false; error: string } {
  const recipientUnacked = unacknowledgedByRecipient.get(recipient);
  if (recipientUnacked && recipientUnacked.size >= MAX_UNACKED_MESSAGES) {
    return { ok: false, error: `Recipient "${recipient}" has too many unacknowledged messages` };
  }

  // Generate a traceId if not provided (every message starts a trace)
  const resolvedTraceId = traceId ?? generateId();

  const message: Message = {
    id: generateId(),
    recipient,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: new Date(),
    acknowledged: false,
    sender,
    contractId,
    traceId: resolvedTraceId,
    reclaimCount: 0,
  };

  createSpan(resolvedTraceId, 'message.queued', {
    messageId: message.id,
    recipient,
    sender: sender ?? null,
    contractId: contractId ?? null,
  });

  messagesById.set(message.id, message);
  dbSaveMessage({
    id: message.id,
    sender: message.sender,
    recipient: message.recipient,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    contractId: message.contractId,
    traceId: message.traceId,
    reclaimCount: 0,
  });
  pushConversationHistory(message);

  if (!messagesByRecipient.has(recipient)) {
    messagesByRecipient.set(recipient, []);
  }
  messagesByRecipient.get(recipient)!.push(message);

  if (!unacknowledgedByRecipient.has(recipient)) {
    unacknowledgedByRecipient.set(recipient, new Set());
  }
  unacknowledgedByRecipient.get(recipient)!.add(message.id);

  return { ok: true, message };
}

// Delivers a queued message to an agent's active WS connection.
// Returns true if delivered via WS; caller may still want the message in the queue for ACK.
function deliverViaWs(targetName: string, message: Message): boolean {
  const targetWs = agentSockets.get(targetName);
  if (!targetWs) return false;
  let payload: unknown = message.content;
  try { payload = JSON.parse(message.content); } catch { /* plain string — keep as-is */ }
  sendWs(targetWs, {
    type: 'message',
    from: message.sender ?? 'server',
    to: targetName,
    payload,
    messageId: message.id,
    timestamp: message.timestamp.toISOString()
  });
  return true;
}

// Drains all queued (unacknowledged) messages for an agent over WS.
// Called when an agent reconnects so they don't have to poll.
function drainQueuedMessages(agentName: string): void {
  // 1. Drain messages addressed directly to this agent by name
  const unackedIds = unacknowledgedByRecipient.get(agentName);
  if (unackedIds && unackedIds.size > 0) {
    for (const id of unackedIds) {
      const msg = messagesById.get(id);
      if (msg) deliverViaWs(agentName, msg);
    }
  }

  // 2. Drain capability queues for the agent's advertised capabilities
  const agent = getAgent(agentName);
  if (!agent || agent.capabilities.length === 0) return;
  for (const cap of agent.capabilities) {
    const capIds = capabilityQueues.get(cap);
    if (!capIds || capIds.size === 0) continue;
    for (const id of capIds) {
      const msg = messagesById.get(id);
      if (msg) {
        // Re-address to this specific agent so ACK tracking works
        msg.recipient = agentName;
        // Re-index under the agent's name
        if (!unacknowledgedByRecipient.has(agentName)) unacknowledgedByRecipient.set(agentName, new Set());
        unacknowledgedByRecipient.get(agentName)!.add(msg.id);
        if (!messagesByRecipient.has(agentName)) messagesByRecipient.set(agentName, []);
        messagesByRecipient.get(agentName)!.push(msg);
        deliverViaWs(agentName, msg);
      }
    }
    // Remove from capability queue – delivered to this agent
    capabilityQueues.delete(cap);
  }
}

/**
 * Routes a message to an online agent advertising the given capability.
 * If no capable agent is online, the message is held in capabilityQueues.
 * Returns true when immediately delivered via WS.
 */
function routeByCapability(capability: string, message: Message): boolean {
  const capable = listAgentsByCapability(capability).filter(a => agentSockets.has(a.name));
  if (capable.length === 0) {
    if (!capabilityQueues.has(capability)) capabilityQueues.set(capability, new Set());
    capabilityQueues.get(capability)!.add(message.id);
    return false;
  }
  // Pick agent with fewest unacked messages (simple load-balance)
  capable.sort((a, b) => {
    const aLoad = unacknowledgedByRecipient.get(a.name)?.size ?? 0;
    const bLoad = unacknowledgedByRecipient.get(b.name)?.size ?? 0;
    return aLoad - bLoad;
  });
  const target = capable[0];
  // Re-address to the chosen agent
  message.recipient = target.name;
  if (!unacknowledgedByRecipient.has(target.name)) unacknowledgedByRecipient.set(target.name, new Set());
  unacknowledgedByRecipient.get(target.name)!.add(message.id);
  if (!messagesByRecipient.has(target.name)) messagesByRecipient.set(target.name, []);
  messagesByRecipient.get(target.name)!.push(message);
  return deliverViaWs(target.name, message);
}

function pushEvent(type: string, eventData: unknown): void {
  const event: BridgeEvent = {
    id: generateId(),
    type,
    timestamp: new Date().toISOString(),
    payload: eventData
  };

  // Use circular buffer instead of shift() for O(1) insertion
  if (eventHistory.length < EVENT_HISTORY_LIMIT) {
    eventHistory.push(event);
  } else {
    eventHistory[eventHistoryIndex] = event;
    eventHistoryIndex = (eventHistoryIndex + 1) % EVENT_HISTORY_LIMIT;
  }

  const sseMessage = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(sseMessage);
    } catch {
      // Client disconnected ungracefully; remove it so it doesn't block future writes
      eventClients.delete(client);
    }
  }
}

function sendEventHistory(res: Response): void {
  // Send events in chronological order accounting for circular buffer
  if (eventHistory.length < EVENT_HISTORY_LIMIT) {
    // Buffer not full yet, send all events in order
    for (const event of eventHistory) {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } else {
    // Buffer is full, start from oldest (next position after current index)
    const oldestIndex = (eventHistoryIndex + 1) % EVENT_HISTORY_LIMIT;
    for (let i = 0; i < EVENT_HISTORY_LIMIT; i++) {
      const index = (oldestIndex + i) % EVENT_HISTORY_LIMIT;
      const event = eventHistory[index];
      if (event) {
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
  }
}

app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sendEventHistory(res);
  eventClients.add(res);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

ensureLockCleanupTimer();

app.post('/publish_message', (req: Request, res: Response) => {
  try {
    const { recipient, capability, content, sender, contractId, traceId, contract } = publishMessageSchema.parse(req.body);

    if (contractId) {
      const existingContract = getContract(contractId);
      if (!existingContract) {
        return sendError(res, 404, 'Contract not found');
      }
    }

    let createdContract: ReturnType<typeof createContract> | undefined;
    let resolvedContractId = contractId;

    if (contract) {
      createdContract = createContract({ ...contract, traceId });
      resolvedContractId = createdContract.id;
      pushEvent('contract.created', {
        contract: serializeContract(createdContract)
      });
    }

    // Determine effective recipient key for queue storage
    const effectiveRecipient = recipient ?? `@cap:${capability}`;

    const queued = queueMessage(effectiveRecipient, content, sender, resolvedContractId, traceId);
    if (!queued.ok) {
      return sendError(res, 429, queued.error);
    }
    const message = queued.message;

    if (resolvedContractId) {
      attachMessageToContract(resolvedContractId, message.id);
      pushEvent('contract.message_linked', {
        contractId: resolvedContractId,
        messageId: message.id
      });
    }

    let wsDelivered = false;
    if (capability) {
      // Capability-based routing
      wsDelivered = routeByCapability(capability, message);
    } else {
      // Direct name-based routing
      wsDelivered = deliverViaWs(recipient!, message);
    }

    pushEvent('message.published', {
      messageId: message.id,
      recipient: effectiveRecipient,
      capability,
      sender,
      contractId: resolvedContractId,
      wsDelivered
    });

    const responseBody: Record<string, unknown> = {
      success: true,
      message: 'Message published successfully',
      messageId: message.id
    };

    if (effectiveRecipient) {
      responseBody.recipient = effectiveRecipient;
    }

    if (capability) {
      responseBody.capability = capability;
    }

    if (resolvedContractId) {
      responseBody.contractId = resolvedContractId;
    }

    if (createdContract) {
      responseBody.contract = serializeContract(createdContract);
    }

    res.status(201).json(responseBody);
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/fetch_messages/:recipient', (req: Request, res: Response) => {
  try {
    const { recipient } = req.params;

    if (!recipient) {
      return sendError(res, 400, 'Recipient parameter is required');
    }

    // O(1) lookup without filtering acknowledged messages
    const recipientMessages: Message[] = [];
    const unacknowledgedMessageIds = unacknowledgedByRecipient.get(recipient);
    if (unacknowledgedMessageIds) {
      for (const messageId of unacknowledgedMessageIds) {
        const message = messagesById.get(messageId);
        if (message) {
          recipientMessages.push(message);
        }
      }
    }

    res.json({
      success: true,
      messages: recipientMessages
    });
  } catch (error) {
    sendError(res, 500, 'Internal server error');
  }
});

app.post('/ack_message', (req: Request, res: Response) => {
  try {
    const { ids } = ackMessageSchema.parse(req.body);

    let acknowledgedCount = 0;
    ids.forEach(id => {
      // O(1) lookup instead of O(n) find
      const message = messagesById.get(id);
      if (message && !message.acknowledged) {
        acknowledgedCount++;
        const recipientMessages = unacknowledgedByRecipient.get(message.recipient);
        if (recipientMessages) {
          recipientMessages.delete(message.id);
          if (recipientMessages.size === 0) {
            unacknowledgedByRecipient.delete(message.recipient);
          }
        }
        pushEvent('message.acknowledged', { messageId: message.id, recipient: message.recipient });
        // Remove from all stores to prevent unbounded memory growth
        messagesById.delete(message.id);
        dbDeleteMessage(message.id);
        const byRecipient = messagesByRecipient.get(message.recipient);
        if (byRecipient) {
          const idx = byRecipient.indexOf(message);
          if (idx !== -1) byRecipient.splice(idx, 1);
        }
      }
    });

    res.json({
      success: true,
      message: `${acknowledgedCount} messages acknowledged`,
      acknowledgedCount
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.post('/contracts', (req: Request, res: Response) => {
  try {
    const payload = contractCreateSchema.parse(req.body);
    const contract = createContract(payload);
    const serialized = serializeContract(contract);
    pushEvent('contract.created', { contract: serialized });
    res.status(201).json({
      success: true,
      contract: serialized
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/contracts', (_req: Request, res: Response) => {
  const all = listContracts().map(serializeContract);
  res.json({ success: true, contracts: all });
});

app.get('/contracts/:id', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const contract = getContract(id);

    if (!contract) {
      return sendError(res, 404, 'Contract not found');
    }

    res.json({
      success: true,
      contract: serializeContract(contract)
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.patch('/contracts/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const payload = contractUpdateSchema.parse(req.body);

    const updatedContract = updateContract(id, payload);
    if (!updatedContract) {
      return sendError(res, 404, 'Contract not found');
    }

    const serialized = serializeContract(updatedContract);
    pushEvent('contract.updated', {
      contract: serialized,
      actor: payload.actor,
      note: payload.note
    });
    if (updatedContract.traceId && payload.status) {
      createSpan(updatedContract.traceId, 'contract.status_changed', {
        contractId: updatedContract.id,
        status: updatedContract.status,
        actor: payload.actor,
      });
    }

    res.json({
      success: true,
      contract: serialized
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.post('/lock_resource', (req: Request, res: Response) => {
  try {
    const { resource, holder, ttl } = lockResourceSchema.parse(req.body);

    if (locks.has(resource)) {
      const existingLock = locks.get(resource)!;
      if (!isLockExpired(existingLock)) {
        // Persist wait so future requests from the holder can detect cycles
        waitingFor.set(holder, resource);
        const cycle = detectDeadlockCycle(holder, resource);

        if (cycle) {
          pushEvent('deadlock.detected', {
            cycle,
            requestedResource: resource,
            requester: holder,
            currentHolder: existingLock.holder,
          });
          return res.status(409).json({
            success: false,
            error: 'deadlock_detected',
            message: `Deadlock detected: ${cycle.join(' → ')}`,
            cycle,
          });
        }
        return sendError(res, 409, 'Resource is already locked');
      }
      // Expired lock — fall through and overwrite
      locks.delete(resource);
    }

    const lock: ResourceLock = {
      resource,
      holder,
      ttl,
      createdAt: new Date()
    };

    locks.set(resource, lock);
    waitingFor.delete(holder); // agent acquired the lock — no longer waiting
    ensureLockCleanupTimer();

    pushEvent('lock.created', {
      resource,
      holder,
      ttl,
      expiresAt: getLockExpiryDate(lock).toISOString()
    });

    res.status(201).json({
      success: true,
      message: 'Resource locked successfully',
      lock: {
        resource: lock.resource,
        holder: lock.holder,
        ttl: lock.ttl,
        expiresAt: getLockExpiryDate(lock)
      }
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.post('/renew_lock', (req: Request, res: Response) => {
  try {
    const { resource, holder, ttl } = renewLockSchema.parse(req.body);

    const existingLock = locks.get(resource);
    if (!existingLock) {
      return sendError(res, 404, 'Lock not found');
    }

    if (existingLock.holder !== holder) {
      return sendError(res, 403, 'Only the lock holder can renew this lock');
    }

    if (isLockExpired(existingLock)) {
      locks.delete(resource);
      pushEvent('lock.expired', {
        resource,
        holder: existingLock.holder
      });
      return sendError(res, 410, 'Lock has expired');
    }

    existingLock.ttl = ttl;
    existingLock.createdAt = new Date();

    pushEvent('lock.renewed', {
      resource,
      holder: existingLock.holder,
      ttl,
      expiresAt: getLockExpiryDate(existingLock).toISOString()
    });

    res.json({
      success: true,
      message: 'Lock renewed successfully',
      lock: {
        resource: existingLock.resource,
        holder: existingLock.holder,
        ttl: existingLock.ttl,
        expiresAt: getLockExpiryDate(existingLock)
      }
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.delete('/unlock_resource/:resource', (req: Request, res: Response) => {
  try {
    const { resource } = req.params;
    const holder = String(req.query.holder || req.body?.holder || '').trim();

    if (!resource) {
      return sendError(res, 400, 'Resource parameter is required');
    }

    const existingLock = locks.get(resource);
    if (!existingLock) {
      return sendError(res, 404, 'Lock not found');
    }

    if (!holder) {
      return sendError(res, 400, 'holder is required to release a lock');
    }
    if (existingLock.holder !== holder) {
      return sendError(res, 403, 'Only the lock holder can release this lock');
    }

    locks.delete(resource);
    // Any agent that was waiting for this resource is no longer blocked
    for (const [agent, res_] of waitingFor) {
      if (res_ === resource) waitingFor.delete(agent);
    }

    pushEvent('lock.released', {
      resource,
      holder: existingLock.holder
    });

    res.json({
      success: true,
      message: 'Resource unlocked successfully'
    });
  } catch (error) {
    sendError(res, 500, 'Internal server error');
  }
});

app.get('/conversation', (_req: Request, res: Response) => {
  const raw = _req.query.limit;
  const limit = Math.min(parseInt(String(raw ?? '20'), 10) || 20, 100);
  const messages = getRecentConversation(limit).map(m => ({
    id: m.id,
    sender: m.sender ?? 'unknown',
    recipient: m.recipient,
    content: m.content,
    timestamp: m.timestamp,
  }));
  res.json({ success: true, messages });
});

// ── Capability routing ────────────────────────────────────────────────────────

app.get('/capabilities', (_req: Request, res: Response) => {
  // Aggregate all advertised capabilities across registered agents
  const capMap = new Map<string, { agents: string[]; onlineCount: number }>();
  for (const agent of listAgents()) {
    for (const cap of agent.capabilities) {
      if (!capMap.has(cap)) capMap.set(cap, { agents: [], onlineCount: 0 });
      const entry = capMap.get(cap)!;
      entry.agents.push(agent.name);
      if (agent.status === 'online' && agentSockets.has(agent.name)) entry.onlineCount++;
    }
  }
  const capabilities = Array.from(capMap.entries()).map(([capability, info]) => ({
    capability,
    agents: info.agents,
    onlineCount: info.onlineCount,
    queued: capabilityQueues.get(capability)?.size ?? 0
  }));
  res.json({ success: true, capabilities });
});

// ── Work claiming ─────────────────────────────────────────────────────────────

app.post('/claim_work', (req: Request, res: Response) => {
  try {
    const { capability, claimant } = claimWorkSchema.parse(req.body);
    const capIds = capabilityQueues.get(capability);
    if (!capIds || capIds.size === 0) {
      return sendError(res, 404, 'no_work_available');
    }
    // Take the oldest queued message (first in insertion order)
    const messageId = capIds.values().next().value as string;
    capIds.delete(messageId);
    if (capIds.size === 0) capabilityQueues.delete(capability);

    const msg = messagesById.get(messageId);
    if (!msg) {
      return sendError(res, 404, 'no_work_available');
    }

    // Re-address to the claimant and record claim for timeout tracking
    const oldRecipient = msg.recipient;
    msg.recipient = claimant;
    msg.claimedAt = new Date();
    msg.claimCapability = capability;
    dbUpdateMessageClaim(msg.id, claimant, msg.claimedAt.toISOString(), capability, msg.reclaimCount ?? 0);

    // Move indexes
    const oldUnacked = unacknowledgedByRecipient.get(oldRecipient);
    if (oldUnacked) {
      oldUnacked.delete(messageId);
      if (oldUnacked.size === 0) unacknowledgedByRecipient.delete(oldRecipient);
    }
    if (!unacknowledgedByRecipient.has(claimant)) unacknowledgedByRecipient.set(claimant, new Set());
    unacknowledgedByRecipient.get(claimant)!.add(messageId);
    if (!messagesByRecipient.has(claimant)) messagesByRecipient.set(claimant, []);
    messagesByRecipient.get(claimant)!.push(msg);

    // Deliver via WS if claimant is online
    deliverViaWs(claimant, msg);

    pushEvent('work.claimed', { capability, claimant, messageId });
    if (msg.traceId) {
      createSpan(msg.traceId, 'work.claimed', { capability, claimant, messageId }, undefined, claimant);
    }

    let payload: unknown = msg.content;
    try { payload = JSON.parse(msg.content); } catch { /* keep as string */ }

    res.json({
      success: true,
      messageId: msg.id,
      message: {
        id: msg.id,
        content: payload,
        sender: msg.sender,
        timestamp: msg.timestamp.toISOString(),
        contractId: msg.contractId
      }
    });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ── Hierarchical contracts ────────────────────────────────────────────────────

app.post('/contracts/:id/subtasks', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const payload = contractCreateSchema.parse(req.body);
    const child = createSubContract(id, payload);
    if (!child) {
      return sendError(res, 404, 'Parent contract not found');
    }
    const serialized = serializeContract(child);
    pushEvent('contract.subtask_created', { parentId: id, contract: serialized });
    res.status(201).json({ success: true, contract: serialized });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/contracts/:id/subtasks', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const parent = getContract(id);
    if (!parent) {
      return sendError(res, 404, 'Contract not found');
    }
    const subtasks = parent.childIds
      .map(cid => getContract(cid))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map(serializeContract);
    res.json({ success: true, subtasks });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ── Contract voting ───────────────────────────────────────────────────────────

app.post('/contracts/:id/vote', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const input = contractVoteSchema.parse(req.body);
    const { contract, result } = voteOnContract(id, input);
    const serialized = serializeContract(contract);

    pushEvent('contract.vote_cast', {
      contractId: id,
      voter: input.voter,
      verdict: input.verdict,
      result,
    });

    if (result.outcome === 'consensus_approved' || result.outcome === 'consensus_rejected') {
      pushEvent('contract.consensus_reached', {
        contractId: id,
        outcome: result.outcome,
        contract: serialized,
      });
      if (contract.traceId) {
        createSpan(contract.traceId, 'contract.consensus_reached', {
          contractId: id,
          outcome: result.outcome,
        });
      }
    }

    res.json({ success: true, contract: serialized, result });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ── Dead letter queue ─────────────────────────────────────────────────────────

app.get('/dlq', (_req: Request, res: Response) => {
  const entries = Array.from(dlq.values()).map(e => ({
    id: e.id,
    reason: e.reason,
    arrivedAt: e.arrivedAt.toISOString(),
    reclaimCount: e.reclaimCount,
    originalMessage: {
      id: e.originalMessage.id,
      sender: e.originalMessage.sender,
      recipient: e.originalMessage.recipient,
      content: e.originalMessage.content,
      timestamp: e.originalMessage.timestamp.toISOString(),
      contractId: e.originalMessage.contractId,
      traceId: e.originalMessage.traceId,
    },
  }));
  res.json({ success: true, count: entries.length, entries });
});

app.post('/dlq/:id/retry', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const entry = dlq.get(id);
    if (!entry) return sendError(res, 404, 'DLQ entry not found');

    const orig = entry.originalMessage;
    const queued = queueMessage(orig.recipient, orig.content, orig.sender, orig.contractId, orig.traceId);
    if (!queued.ok) return sendError(res, 429, queued.error);

    dlq.delete(id);
    dbDeleteDlqEntry(id);

    pushEvent('message.dlq_retried', { dlqId: id, newMessageId: queued.message.id });
    res.json({ success: true, messageId: queued.message.id });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.delete('/dlq/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!dlq.has(id)) return sendError(res, 404, 'DLQ entry not found');
    dlq.delete(id);
    dbDeleteDlqEntry(id);
    pushEvent('message.dlq_discarded', { dlqId: id });
    res.json({ success: true });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ── Distributed traces ────────────────────────────────────────────────────────

app.get('/traces/:traceId', (req: Request, res: Response) => {
  const { traceId } = req.params;
  const spans = traceSpans.get(traceId);
  if (!spans) return sendError(res, 404, 'Trace not found');
  res.json({ success: true, traceId, spanCount: spans.length, spans });
});

// ── Agent thoughts ────────────────────────────────────────────────────────────

app.post('/agents/:name/thoughts', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const agent = getAgent(name);
    if (!agent) {
      return sendError(res, 404, 'Agent not found');
    }
    const { reasoning, phase, progress } = agentThoughtSchema.parse(req.body);
    const thought: AgentThought = {
      id: generateId(),
      agent: name,
      timestamp: new Date().toISOString(),
      phase,
      progress,
      reasoning
    };
    if (!agentThoughts.has(name)) agentThoughts.set(name, []);
    const list = agentThoughts.get(name)!;
    list.push(thought);
    if (list.length > AGENT_THOUGHTS_LIMIT) list.shift();
    pushEvent('agent.thought', thought);
    res.status(201).json({ success: true, thought });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/agents/:name/thoughts', (req: Request, res: Response) => {
  const { name } = req.params;
  const agent = getAgent(name);
  if (!agent) {
    return sendError(res, 404, 'Agent not found');
  }
  const thoughts = agentThoughts.get(name) ?? [];
  res.json({ success: true, thoughts });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Agent-Bridge server is running',
    timestamp: new Date().toISOString(),
    connectedAgents: Array.from(agentSockets.keys())
  });
});

// ── Agent memory ──────────────────────────────────────────────────────────────

// Prune expired memory entries every 5 minutes
const memoryPruneTimer = setInterval(() => {
  try { dbMemoryPruneExpired(); } catch (err) {
    console.error('[memory-prune] Error:', err);
  }
}, 5 * 60 * 1000);
memoryPruneTimer.unref();

app.get('/agents/:name/memory', (req: Request, res: Response) => {
  const { name } = req.params;
  if (!getAgent(name)) return sendError(res, 404, 'Agent not found');
  const now = new Date().toISOString();
  const entries = dbMemoryList(name)
    .filter(e => !e.expiresAt || e.expiresAt > now)
    .map(e => ({
      key: e.key,
      value: JSON.parse(e.value),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      expiresAt: e.expiresAt,
    }));
  res.json({ success: true, agent: name, count: entries.length, entries });
});

app.get('/agents/:name/memory/:key', (req: Request, res: Response) => {
  try {
    const { name, key } = req.params;
    memoryKeySchema.parse(key);
    if (!getAgent(name)) return sendError(res, 404, 'Agent not found');
    const entry = dbMemoryGet(name, key);
    if (!entry) return sendError(res, 404, 'Memory key not found');
    if (entry.expiresAt && entry.expiresAt < new Date().toISOString()) {
      dbMemoryDelete(name, key);
      return sendError(res, 404, 'Memory key expired');
    }
    res.json({
      success: true,
      key: entry.key,
      value: JSON.parse(entry.value),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    });
  } catch (error) { handleRouteError(error, res); }
});

app.post('/agents/:name/memory/:key', (req: Request, res: Response) => {
  try {
    const { name, key } = req.params;
    memoryKeySchema.parse(key);
    if (!getAgent(name)) return sendError(res, 404, 'Agent not found');
    const { value, ttlSeconds } = memorySetSchema.parse(req.body);
    const now = new Date().toISOString();
    const existing = dbMemoryGet(name, key);
    const expiresAt = ttlSeconds
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : undefined;
    dbMemorySet({
      agentName: name,
      key,
      value: JSON.stringify(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt,
    });
    pushEvent('agent.memory_updated', { agent: name, key, expiresAt });
    res.status(existing ? 200 : 201).json({ success: true, key, expiresAt });
  } catch (error) { handleRouteError(error, res); }
});

app.delete('/agents/:name/memory/:key', (req: Request, res: Response) => {
  try {
    const { name, key } = req.params;
    memoryKeySchema.parse(key);
    if (!getAgent(name)) return sendError(res, 404, 'Agent not found');
    const deleted = dbMemoryDelete(name, key);
    if (!deleted) return sendError(res, 404, 'Memory key not found');
    pushEvent('agent.memory_deleted', { agent: name, key });
    res.json({ success: true });
  } catch (error) { handleRouteError(error, res); }
});

app.delete('/agents/:name/memory', (req: Request, res: Response) => {
  const { name } = req.params;
  if (!getAgent(name)) return sendError(res, 404, 'Agent not found');
  const count = dbMemoryDeleteAgent(name);
  pushEvent('agent.memory_cleared', { agent: name, deletedKeys: count });
  res.json({ success: true, deletedKeys: count });
});

// --- Agent Registry REST endpoints ---

const agentStatusUpdateSchema = z.object({
  status: z.enum(['online', 'offline', 'busy'])
});

app.post('/agents/register', (req: Request, res: Response) => {
  try {
    const input = agentRegisterSchema.parse(req.body);
    const agent = registerAgent(input);
    pushEvent('agent.registered', { agent: serializeAgent(agent) });
    res.status(201).json({ success: true, agent: serializeAgent(agent) });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/agents', (_req: Request, res: Response) => {
  const all = listAgents().map(serializeAgent);
  res.json({ success: true, agents: all });
});

app.get('/agents/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const agent = getAgent(name);
  if (!agent) {
    return sendError(res, 404, 'Agent not found');
  }
  res.json({ success: true, agent: serializeAgent(agent) });
});

app.patch('/agents/:name/status', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { status } = agentStatusUpdateSchema.parse(req.body);
    const ok = setAgentStatus(name, status as AgentStatus);
    if (!ok) {
      return sendError(res, 404, 'Agent not found');
    }
    const agent = getAgent(name);
    if (!agent) {
      return sendError(res, 404, 'Agent not found');
    }
    pushEvent('agent.status_updated', { agent: name, status });
    res.json({ success: true, agent: serializeAgent(agent) });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.delete('/agents/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const ok = deregisterAgent(name);
  if (!ok) {
    return sendError(res, 404, 'Agent not found');
  }
  // Also close WebSocket if connected
  const ws = agentSockets.get(name);
  if (ws) {
    ws.close(1000, 'deregistered');
    agentSockets.delete(name);
  }
  pushEvent('agent.deregistered', { agent: name });
  res.json({ success: true, message: `Agent ${name} deregistered` });
});

// ── Simulation engine ─────────────────────────────────────────────────────────

const simulateStubSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('echo') }).strict(),
  z.object({ type: z.literal('fixed'), response: z.string() }).strict(),
  z.object({ type: z.literal('sequence'), responses: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal('handoff'), to: z.string(), message: z.string().optional() }).strict(),
]);

const simulateSchema = z.object({
  task: z.string().min(1).max(4000),
  recipient: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
  agents: z.record(
    z.string().min(1).max(64),
    z.object({
      capabilities: z.array(z.string()).default([]),
      stub: simulateStubSchema,
      latencyMs: z.number().int().min(0).max(5000).default(0),
    }),
  ),
  maxHops: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(100).max(30000).default(10000),
}).superRefine((d, ctx) => {
  if (!d.recipient && !d.capability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either recipient or capability', path: ['recipient'] });
  }
  if (d.recipient && d.capability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either recipient or capability, not both', path: ['capability'] });
  }
});

type SimSpec = z.infer<typeof simulateSchema>;

interface SimTimelineEntry {
  hop: number;
  agent: string;
  action: 'received' | 'responded' | 'handoff';
  content: string;
  to?: string;
  latencyMs: number;
}

/** ACK a message and remove it from all in-memory + DB stores (simulation use only). */
function ackSimMessage(msg: Message): void {
  if (msg.acknowledged) return;
  msg.acknowledged = true;
  const unacked = unacknowledgedByRecipient.get(msg.recipient);
  if (unacked) {
    unacked.delete(msg.id);
    if (unacked.size === 0) unacknowledgedByRecipient.delete(msg.recipient);
  }
  messagesById.delete(msg.id);
  dbDeleteMessage(msg.id);
  const byRecipient = messagesByRecipient.get(msg.recipient);
  if (byRecipient) {
    const idx = byRecipient.indexOf(msg);
    if (idx !== -1) byRecipient.splice(idx, 1);
    if (byRecipient.length === 0) messagesByRecipient.delete(msg.recipient);
  }
}

/** Redirect a message from a capability placeholder to a specific stub agent. */
function routeCapMessageToAgent(msgId: string, capability: string, agentName: string): void {
  const msg = messagesById.get(msgId);
  if (!msg) return;
  const capIds = capabilityQueues.get(capability);
  if (capIds) {
    capIds.delete(msgId);
    if (capIds.size === 0) capabilityQueues.delete(capability);
  }
  const oldRecipient = msg.recipient;
  const oldUnacked = unacknowledgedByRecipient.get(oldRecipient);
  if (oldUnacked) { oldUnacked.delete(msgId); if (oldUnacked.size === 0) unacknowledgedByRecipient.delete(oldRecipient); }
  const oldList = messagesByRecipient.get(oldRecipient);
  if (oldList) { const i = oldList.indexOf(msg); if (i !== -1) oldList.splice(i, 1); if (oldList.length === 0) messagesByRecipient.delete(oldRecipient); }

  msg.recipient = agentName;
  if (!messagesByRecipient.has(agentName)) messagesByRecipient.set(agentName, []);
  messagesByRecipient.get(agentName)!.push(msg);
  if (!unacknowledgedByRecipient.has(agentName)) unacknowledgedByRecipient.set(agentName, new Set());
  unacknowledgedByRecipient.get(agentName)!.add(msgId);
  dbUpdateMessageClaim(msgId, agentName, null, null, 0);
}

/** Apply stub logic to produce a response string. */
function applyStub(
  stub: SimSpec['agents'][string]['stub'],
  input: string,
  agentName: string,
  seqIndices: Map<string, number>,
): string {
  switch (stub.type) {
    case 'echo': return input;
    case 'fixed': return stub.response;
    case 'handoff': return `${stub.message ?? input}\nHANDOFF: ${stub.to}`;
    case 'sequence': {
      const idx = seqIndices.get(agentName) ?? 0;
      seqIndices.set(agentName, idx + 1);
      return stub.responses[idx % stub.responses.length];
    }
  }
}

async function runSimulation(spec: SimSpec): Promise<{
  success: boolean; completedNormally: boolean; durationMs: number;
  hops: number; finalOutput?: string; timeline: SimTimelineEntry[];
}> {
  const startTime = Date.now();
  const timeline: SimTimelineEntry[] = [];
  const simAgents = new Set(Object.keys(spec.agents));
  const seqIndices = new Map<string, number>();
  let hops = 0;
  let completedNormally = false;

  // Register all stub agents
  for (const [name, cfg] of Object.entries(spec.agents)) {
    registerAgent({ name, type: 'simulation-stub', capabilities: cfg.capabilities });
  }

  // Queue initial task – resolve capability to a stub agent directly (no WS needed)
  let target: string;
  if (spec.capability) {
    const match = Object.entries(spec.agents)
      .find(([, cfg]) => cfg.capabilities.includes(spec.capability!));
    target = match ? match[0] : `@cap:${spec.capability}`;
  } else {
    target = spec.recipient!;
  }
  const initial = queueMessage(target, spec.task, 'simulation');
  if (!initial.ok) {
    cleanupSim();
    return { success: false, completedNormally: false, durationMs: 0, hops: 0, timeline };
  }

  const deadline = Date.now() + spec.timeoutMs;

  outer: while (hops < spec.maxHops && Date.now() < deadline) {
    let processed = false;

    for (const [agentName, stubCfg] of Object.entries(spec.agents)) {
      const pending = (messagesByRecipient.get(agentName) ?? []).filter(m => !m.acknowledged);
      if (pending.length === 0) continue;

      const msg = pending[0];
      hops++;
      timeline.push({ hop: hops, agent: agentName, action: 'received', content: msg.content, latencyMs: 0 });

      if (stubCfg.latencyMs > 0) await new Promise(r => setTimeout(r, stubCfg.latencyMs));

      const response = applyStub(stubCfg.stub, msg.content, agentName, seqIndices);
      ackSimMessage(msg);

      const handoffMatch = response.match(/HANDOFF:\s*(\S+)/i);
      if (handoffMatch) {
        const nextAgent = handoffMatch[1].trim();
        if (simAgents.has(nextAgent)) {
          queueMessage(nextAgent, response, agentName);
          timeline.push({ hop: hops, agent: agentName, action: 'handoff', content: response, to: nextAgent, latencyMs: stubCfg.latencyMs });
        } else {
          // Handoff to unknown agent — treat as terminal
          timeline.push({ hop: hops, agent: agentName, action: 'responded', content: response, latencyMs: stubCfg.latencyMs });
          completedNormally = true;
          break outer;
        }
      } else {
        timeline.push({ hop: hops, agent: agentName, action: 'responded', content: response, latencyMs: stubCfg.latencyMs });
        completedNormally = true;
        break outer;
      }

      processed = true;
      break;
    }

    if (!processed) { completedNormally = true; break; }
  }

  cleanupSim();
  const durationMs = Date.now() - startTime;
  pushEvent('simulation.complete', { hops, completedNormally, durationMs, agentCount: simAgents.size });

  const finalOutput = [...timeline].reverse().find(e => e.action !== 'received')?.content;
  return { success: true, completedNormally, durationMs, hops, finalOutput, timeline };

  function cleanupSim() {
    for (const name of simAgents) {
      const leftover = (messagesByRecipient.get(name) ?? []).filter(m => !m.acknowledged);
      for (const m of leftover) ackSimMessage(m);
      deregisterAgent(name);
    }
  }
}

app.post('/simulate', async (req: Request, res: Response) => {
  try {
    const spec = simulateSchema.parse(req.body);
    pushEvent('simulation.start', {
      agents: Object.keys(spec.agents),
      task: spec.task.slice(0, 100),
      maxHops: spec.maxHops,
    });
    const result = await runSimulation(spec);
    res.json(result);
  } catch (error) {
    handleRouteError(error, res);
  }
});

export function clearEventHistory(): void {
  eventHistory.length = 0;
  eventHistoryIndex = 0;
  unacknowledgedByRecipient.clear();
  messagesByRecipient.clear();
  messagesById.clear();
  dbClearMessages();
  if (lockCleanupTimer) {
    clearInterval(lockCleanupTimer);
    lockCleanupTimer = null;
  }
  locks.clear();
  waitingFor.clear();
  capabilityQueues.clear();
  agentThoughts.clear();
  dlq.clear();
  dbClearDlq();
  traceSpans.clear();
  dbMemoryClearAll();
}

export function clearConversationHistory(): void {
  conversationHistory.fill(undefined);
  conversationHistoryIndex = 0;
  conversationHistorySize = 0;
}

/** Exported for testing only. */
export { sweepStaleClaims, checkOverdueContracts };

/** Stop all background timers. Call in afterAll() to prevent Jest open-handle warnings. */
export function stopBackgroundTimers(): void {
  clearInterval(messagePruneTimer);
  clearInterval(claimSweepTimer);
  clearInterval(slaCheckTimer);
  clearInterval(memoryPruneTimer);
}

// ── Global error handlers ─────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught Exception:', err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[shutdown] Received ${signal}, shutting down gracefully…`);

  // Stop accepting new HTTP/WS connections
  server.close(() => console.log('[shutdown] HTTP server closed'));

  // Close all active WebSocket connections
  for (const [name, ws] of agentSockets) {
    ws.close(1001, 'Server shutting down');
    agentSockets.delete(name);
  }

  // Flush any pending contract writes before exiting
  try {
    await flushContractPersistence();
    console.log('[shutdown] Contract persistence flushed');
  } catch (err) {
    console.error('[shutdown] Failed to flush contract persistence:', err);
  }

  // Stop background timers
  clearInterval(messagePruneTimer);
  if (lockCleanupTimer) {
    clearInterval(lockCleanupTimer);
    lockCleanupTimer = null;
  }

  process.exit(0);
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Agent-Bridge server is running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });
}

export { server };

export default app;
