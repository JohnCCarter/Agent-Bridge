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
  createContract,
  getContract,
  listContracts,
  updateContract,
  serializeContract,
  attachMessageToContract
} from './contracts';
import {
  agentRegisterSchema,
  registerAgent,
  deregisterAgent,
  heartbeatAgent,
  setAgentStatus,
  getAgent,
  listAgents,
  serializeAgent,
  AgentStatus
} from './agent-registry';
import path from 'path';

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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_MAX_PAYLOAD });

// Map from agentName → WebSocket connection
const agentSockets = new Map<string, WebSocket>();

interface WsEnvelope {
  type: 'register' | 'message' | 'broadcast' | 'heartbeat' | 'status';
  from?: string;
  to?: string;
  payload?: unknown;
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
        // Sync with agent registry: heartbeat if known, otherwise auto-register
        if (!heartbeatAgent(name)) {
          registerAgent({ name, type: 'ws-agent', capabilities: [] });
        }
        sendWs(ws, { type: 'registered', agent: name, peers: Array.from(agentSockets.keys()).filter(k => k !== name) });
        broadcastWs({ type: 'agent.joined', agent: name }, ws);
        pushEvent('agent.connected', { agent: name });
        // Deliver any messages that arrived while this agent was offline
        drainQueuedMessages(name);
        break;
      }
      case 'message': {
        const to = String(envelope.to || '').trim();
        const from = connectedAgentName || String(envelope.from || '').trim();
        if (!to || !from) {
          sendWs(ws, { type: 'error', error: 'from and to required for message' });
          return;
        }
        // Always queue so the message reaches conversationHistory and SSE subscribers
        const content = typeof envelope.payload === 'string'
          ? envelope.payload
          : JSON.stringify(envelope.payload ?? '');
        const queued = queueMessage(to, content, from);
        if (!queued.ok) {
          sendWs(ws, { type: 'error', error: queued.error });
          break;
        }
        // Deliver immediately if recipient is online; otherwise waits in queue until reconnect
        const wsDelivered = deliverViaWs(to, queued.message);
        if (!wsDelivered) {
          sendWs(ws, { type: 'message.queued', to, messageId: queued.message.id, reason: 'recipient offline' });
        }
        // Fire the same SSE event as POST /publish_message so dashboard/chat.js sees it
        pushEvent('message.published', { messageId: queued.message.id, from, to, delivered: wsDelivered });
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

const messagesById = new Map<string, Message>();
const messagesByRecipient = new Map<string, Message[]>();
const unacknowledgedByRecipient = new Map<string, Set<string>>();
const locks: Map<string, ResourceLock> = new Map();

// Ordered log of every published message for the /conversation endpoint
const conversationHistory: Message[] = [];

// ── Message TTL pruning ───────────────────────────────────────────────────────
function pruneExpiredMessages(): void {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  for (const [id, msg] of messagesById) {
    if (!msg.acknowledged && msg.timestamp.getTime() < cutoff) {
      messagesById.delete(id);
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
const eventClients = new Set<Response>();
const eventHistory: BridgeEvent[] = [];
let eventHistoryIndex = 0;
const EVENT_HISTORY_LIMIT = 100;
const CONVERSATION_HISTORY_LIMIT = 1000;
const LOCK_CLEANUP_INTERVAL_MS = 30_000;
let lockCleanupTimer: NodeJS.Timeout | null = null;

const publishMessageSchema = z.object({
  recipient: z.string().min(1),
  content: z.string().min(1),
  sender: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
  contract: contractCreateSchema.optional()
}).superRefine((messageData, ctx) => {
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
  contractId?: string
): { ok: true; message: Message } | { ok: false; error: string } {
  const recipientUnacked = unacknowledgedByRecipient.get(recipient);
  if (recipientUnacked && recipientUnacked.size >= MAX_UNACKED_MESSAGES) {
    return { ok: false, error: `Recipient "${recipient}" has too many unacknowledged messages` };
  }

  const message: Message = {
    id: generateId(),
    recipient,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: new Date(),
    acknowledged: false,
    sender,
    contractId
  };

  messagesById.set(message.id, message);
  if (conversationHistory.length >= CONVERSATION_HISTORY_LIMIT) {
    conversationHistory.shift();
  }
  conversationHistory.push(message);

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
  const unackedIds = unacknowledgedByRecipient.get(agentName);
  if (!unackedIds || unackedIds.size === 0) return;
  for (const id of unackedIds) {
    const msg = messagesById.get(id);
    if (msg) deliverViaWs(agentName, msg);
  }
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
    const { recipient, content, sender, contractId, contract } = publishMessageSchema.parse(req.body);

    if (contractId) {
      const existingContract = getContract(contractId);
      if (!existingContract) {
        return sendError(res, 404, 'Contract not found');
      }
    }

    let createdContract: ReturnType<typeof createContract> | undefined;
    let resolvedContractId = contractId;

    if (contract) {
      createdContract = createContract(contract);
      resolvedContractId = createdContract.id;
      pushEvent('contract.created', {
        contract: serializeContract(createdContract)
      });
    }

    const queued = queueMessage(recipient, content, sender, resolvedContractId);
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

    // Push immediately to recipient's WS connection if online
    const wsDelivered = deliverViaWs(recipient, message);

    pushEvent('message.published', {
      messageId: message.id,
      recipient,
      sender,
      contractId: resolvedContractId,
      wsDelivered
    });

    const responseBody: Record<string, unknown> = {
      success: true,
      message: 'Message published successfully',
      messageId: message.id
    };

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

app.get('/contracts', requireApiKey, (_req: Request, res: Response) => {
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
      return sendError(res, 409, 'Resource is already locked');
    }

    const lock: ResourceLock = {
      resource,
      holder,
      ttl,
      createdAt: new Date()
    };

    locks.set(resource, lock);
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
  const messages = conversationHistory.slice(-limit).map(m => ({
    id: m.id,
    sender: m.sender ?? 'unknown',
    recipient: m.recipient,
    content: m.content,
    timestamp: m.timestamp,
  }));
  res.json({ success: true, messages });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Agent-Bridge server is running',
    timestamp: new Date().toISOString(),
    connectedAgents: Array.from(agentSockets.keys())
  });
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

export function clearEventHistory(): void {
  eventHistory.length = 0;
  eventHistoryIndex = 0;
  unacknowledgedByRecipient.clear();
  messagesByRecipient.clear();
  messagesById.clear();
  if (lockCleanupTimer) {
    clearInterval(lockCleanupTimer);
    lockCleanupTimer = null;
  }
  locks.clear();
}

export function clearConversationHistory(): void {
  conversationHistory.length = 0;
}

/** Stop all background timers. Call in afterAll() to prevent Jest open-handle warnings. */
export function stopBackgroundTimers(): void {
  clearInterval(messagePruneTimer);
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Agent-Bridge server is running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });
}

export { server };

export default app;
