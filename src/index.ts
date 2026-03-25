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
  type ContractPriority,
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
  dbSaveExperience,
  dbListExperiencesByAgent,
  dbListExperiencesByCapability,
  dbIncrementExperienceEndorsements,
  dbClearExperiences,
  dbSaveReward,
  dbListRewardsByAgent,
  dbSumRewardsByAgent,
  dbClearRewards,
  dbUpsertSkillScore,
  dbGetSkillScore,
  dbListSkillsByAgent,
  dbListSkillsByCapability,
  dbListAllSkillScores,
  dbClearSkillScores,
  dbUpsertTrustEdge,
  dbGetTrustEdge,
  dbListTrustFrom,
  dbListTrustTo,
  dbListAllTrustEdges,
  dbClearTrustEdges,
  dbUpsertPheromoneTrail,
  dbGetPheromoneTrail,
  dbListPheromonesByCapability,
  dbListAllPheromoneTrails,
  dbDecayAllPheromones,
  dbClearPheromoneTrails,
  PersistedExperience,
  PersistedSkillScore,
  PersistedTrustEdge,
  PersistedPheromoneTrail,
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
  type: 'register' | 'message' | 'broadcast' | 'heartbeat' | 'status' | 'thought'
      | 'subscribe' | 'unsubscribe' | 'publish';
  from?: string;
  to?: string;
  capability?: string;    // capability-based routing in 'message'
  capabilities?: string[]; // advertised capabilities in 'register'
  topic?: string;          // topic name for subscribe/unsubscribe/publish
  payload?: unknown;
}

// ── Topic Pub/Sub ─────────────────────────────────────────────────────────────

interface Topic {
  name: string;
  description?: string;
  /** If set, only agents with this capability are auto-subscribed on connect. */
  capability?: string;
  createdAt: string;
  createdBy: string;
}

/** topic name → Topic metadata */
const topics = new Map<string, Topic>();

/** topic name → Set of explicitly subscribed agent names */
const topicSubscriptions = new Map<string, Set<string>>();

const TOPIC_NAME_RE = /^[\w\-:.@]+$/;
const TOPIC_NAME_MAX_LEN = 64;

function normaliseTopic(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

// ── Trigger system (Myceliummergi pulse) ──────────────────────────────────────

type TriggerActionType = 'publish_message' | 'create_contract' | 'publish_topic';

interface TriggerAction {
  type: TriggerActionType;
  // publish_message
  content?: string;
  sender?: string;
  recipient?: string;
  capability?: string;
  // create_contract
  title?: string;
  initiator?: string;
  priority?: string;
  tags?: string[];
  // publish_topic
  topic?: string;
  publisher?: string;
  payload?: unknown;
}

interface Trigger {
  id: string;
  name: string;
  type: 'interval' | 'webhook';
  enabled: boolean;
  intervalMs?: number;    // only for 'interval' type
  action: TriggerAction;
  createdAt: string;
  lastFiredAt?: string;
  fireCount: number;
  description?: string;
}

const triggers = new Map<string, Trigger>();

const TRIGGER_MIN_INTERVAL_MS = 1000; // 1 second minimum to prevent runaway loops

const triggerActionSchema: z.ZodType<TriggerAction> = z.object({
  type: z.enum(['publish_message', 'create_contract', 'publish_topic']),
  content: z.string().min(1).optional(),
  sender: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  initiator: z.string().min(1).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  tags: z.array(z.string().min(1)).optional(),
  topic: z.string().min(1).optional(),
  publisher: z.string().min(1).optional(),
  payload: z.unknown().optional(),
}).superRefine((a, ctx) => {
  if (a.type === 'publish_message') {
    if (!a.content) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'publish_message requires content' });
    if (!a.sender)  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'publish_message requires sender' });
    if (!a.recipient && !a.capability) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'publish_message requires recipient or capability' });
  }
  if (a.type === 'create_contract') {
    if (!a.title)     ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'create_contract requires title' });
    if (!a.initiator) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'create_contract requires initiator' });
  }
  if (a.type === 'publish_topic') {
    if (!a.topic)     ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'publish_topic requires topic' });
    if (!a.publisher) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'publish_topic requires publisher' });
  }
});

const triggerCreateSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.enum(['interval', 'webhook']),
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(TRIGGER_MIN_INTERVAL_MS).optional(),
  action: triggerActionSchema,
  description: z.string().max(500).optional(),
}).superRefine((t, ctx) => {
  if (t.type === 'interval' && !t.intervalMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'interval trigger requires intervalMs' });
  }
});

const triggerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(TRIGGER_MIN_INTERVAL_MS).optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  action: triggerActionSchema.optional(),
}).strict();

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
        // Auto-subscribe to capability-filtered topics
        autoSubscribeByCapability(name);
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
      case 'subscribe': {
        if (!connectedAgentName) {
          sendWs(ws, { type: 'error', error: 'must register before subscribing' });
          break;
        }
        const topicName = normaliseTopic(envelope.topic);
        if (!topicName || topicName.length > TOPIC_NAME_MAX_LEN || !TOPIC_NAME_RE.test(topicName)) {
          sendWs(ws, { type: 'error', error: 'invalid topic name' });
          break;
        }
        if (!topicSubscriptions.has(topicName)) topicSubscriptions.set(topicName, new Set());
        topicSubscriptions.get(topicName)!.add(connectedAgentName);
        sendWs(ws, { type: 'subscribe.ack', topic: topicName });
        break;
      }
      case 'unsubscribe': {
        if (!connectedAgentName) {
          sendWs(ws, { type: 'error', error: 'must register before unsubscribing' });
          break;
        }
        const topicName = normaliseTopic(envelope.topic);
        topicSubscriptions.get(topicName)?.delete(connectedAgentName);
        sendWs(ws, { type: 'unsubscribe.ack', topic: topicName });
        break;
      }
      case 'publish': {
        if (!connectedAgentName) {
          sendWs(ws, { type: 'error', error: 'must register before publishing' });
          break;
        }
        const topicName = normaliseTopic(envelope.topic);
        if (!topicName || !topics.has(topicName)) {
          sendWs(ws, { type: 'error', error: `topic '${topicName}' does not exist` });
          break;
        }
        const delivered = deliverToTopic(topicName, connectedAgentName, envelope.payload);
        sendWs(ws, { type: 'publish.ack', topic: topicName, delivered });
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
app.get('/', dashboardLimiter, (_req, res) => {
  res.redirect('/mycelium');
});
app.get('/mycelium', dashboardLimiter, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'mycelium.html'));
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

// ── Adaptive Agent Mesh types ──────────────────────────────────────────────────

export interface AgentExperience {
  id: string;
  agentName: string;
  capability: string;
  taskSummary: string;
  outcome: 'success' | 'failure' | 'partial';
  durationMs: number;
  contractId?: string;
  messageId?: string;
  endorsements: number;
  timestamp: string;
}

export type RewardReason =
  | 'task_completed'
  | 'task_failed'
  | 'peer_endorsed'
  | 'timeout'
  | 'dlq'
  | 'fast_delivery'
  | 'contract_overdue';

export interface AgentReward {
  id: string;
  agentName: string;
  points: number;
  reason: RewardReason;
  contractId?: string;
  messageId?: string;
  endorsedBy?: string;
  timestamp: string;
}

export type AgentTier = 'novice' | 'competent' | 'expert' | 'rehabilitating';

export interface SkillScore {
  agentName: string;
  capability: string;
  successCount: number;
  failureCount: number;
  partialCount: number;
  totalJobs: number;
  avgDuration: number;
  endorsements: number;
  score: number;
  tier: AgentTier;
  lastUpdated: string;
}

export interface TrustEdge {
  fromAgent: string;
  toAgent: string;
  capability: string;
  score: number;       // 0.0 – 1.0; unknown = no edge (not 0)
  interactions: number;
  lastUpdated: string;
}

// How much a single positive/negative interaction shifts trust
const TRUST_POSITIVE_DELTA = 0.08;
const TRUST_NEGATIVE_DELTA = 0.12;
const TRUST_INITIAL_SCORE  = 0.5;   // neutral starting point on first interaction
const TRUST_MIN = 0.0;
const TRUST_MAX = 1.0;

export interface PheromoneTrail {
  sender: string;
  capability: string;
  receiver: string;
  strength: number;
  lastReinforced: string;
}

const PHEROMONE_REINFORCE_DELTA = 0.15;  // added on success
const PHEROMONE_ERODE_FACTOR    = 3.0;   // failure erodes 3× faster than normal decay
const PHEROMONE_DECAY_FACTOR    = 0.95;  // applied every 10 minutes
const PHEROMONE_MIN_STRENGTH    = 0.01;  // trails below this are pruned

const REWARD_POINTS: Record<RewardReason, number> = {
  task_completed:    10,
  task_failed:       -5,
  peer_endorsed:      7,
  timeout:           -8,
  dlq:               -8,
  fast_delivery:      3,
  contract_overdue:  -3,
};

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

// ── Adaptive Agent Mesh stores ─────────────────────────────────────────────────
// In-memory caches for fast routing decisions; persisted to SQLite.
const skillScoreCache = new Map<string, SkillScore>(); // `${agent}::${cap}` → SkillScore
const trustCache = new Map<string, TrustEdge>();       // `${from}::${to}::${cap}` → TrustEdge
const pheromoneCache = new Map<string, PheromoneTrail>(); // `${sender}::${cap}::${recv}` → trail

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

  // Auto-penalise the last claimant (if any) when their claimed work expires to DLQ
  if (reason === 'max_reclaims' && msg.claimCapability && msg.sender) {
    issueReward(msg.sender, 'dlq', { capability: msg.claimCapability, messageId: msg.id });
    // Erode pheromone trail for this failed path
    erodePheromone(msg.sender, msg.claimCapability, msg.recipient);
  }
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
      // Penalise the contract assignee if known
      const contract = getContract(v.contractId);
      if (contract?.owner) {
        issueReward(contract.owner, 'contract_overdue', { contractId: v.contractId });
      }
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
 * Deliver a payload to all subscribers of a topic.
 * Returns the count of online subscribers that received the message.
 */
function deliverToTopic(topicName: string, publisherName: string, payload: unknown): number {
  const topic = topics.get(topicName);
  if (!topic) return 0;

  // Build the full subscriber set: explicit subs + capability-matching online agents
  const recipients = new Set<string>(topicSubscriptions.get(topicName) ?? []);

  if (topic.capability) {
    for (const a of listAgentsByCapability(topic.capability)) {
      if (agentSockets.has(a.name)) recipients.add(a.name);
    }
  }

  // Never deliver back to the publisher
  recipients.delete(publisherName);

  let delivered = 0;
  const event = {
    type: 'topic.message',
    topic: topicName,
    from: publisherName,
    payload,
    timestamp: new Date().toISOString(),
  };
  for (const agentName of recipients) {
    const ws = agentSockets.get(agentName);
    if (ws) {
      sendWs(ws, event);
      delivered++;
    }
  }
  pushEvent('topic.published', { topic: topicName, publisher: publisherName, subscribers: delivered });
  return delivered;
}

/**
 * Auto-subscribe a newly connected agent to all topics that match its capabilities.
 */
function autoSubscribeByCapability(agentName: string): void {
  const agent = getAgent(agentName);
  if (!agent || agent.capabilities.length === 0) return;
  for (const [topicName, topic] of topics) {
    if (topic.capability && agent.capabilities.includes(topic.capability)) {
      if (!topicSubscriptions.has(topicName)) topicSubscriptions.set(topicName, new Set());
      topicSubscriptions.get(topicName)!.add(agentName);
    }
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
  // Adaptive routing: filter out rehabilitating agents, then rank by combined trust+skill score
  const sender = message.sender;
  const eligible = capable.filter(a => {
    const s = skillScoreCache.get(skillCacheKey(a.name, capability))
      ?? dbGetSkillScore(a.name, capability);
    return !s || s.tier !== 'rehabilitating';
  });
  const pool = eligible.length > 0 ? eligible : capable; // fall back if all are rehabilitating
  pool.sort((a, b) => {
    // Combined score: 60% skill, 40% trust (if sender known)
    const aSkill = (skillScoreCache.get(skillCacheKey(a.name, capability)) ?? dbGetSkillScore(a.name, capability))?.score ?? 0;
    const bSkill = (skillScoreCache.get(skillCacheKey(b.name, capability)) ?? dbGetSkillScore(b.name, capability))?.score ?? 0;
    const aTrust = sender ? (getTrustScore(sender, a.name, capability) ?? aSkill) : aSkill;
    const bTrust = sender ? (getTrustScore(sender, b.name, capability) ?? bSkill) : bSkill;
    const aPhero = sender ? (getPheromoneStrength(sender, capability, a.name) ?? 0) : 0;
    const bPhero = sender ? (getPheromoneStrength(sender, capability, b.name) ?? 0) : 0;
    // 50% skill + 30% trust + 20% pheromone (emergent collective signal)
    const aCombined = sender ? 0.5 * aSkill + 0.3 * aTrust + 0.2 * aPhero : aSkill;
    const bCombined = sender ? 0.5 * bSkill + 0.3 * bTrust + 0.2 * bPhero : bSkill;
    if (Math.abs(bCombined - aCombined) > 0.01) return bCombined - aCombined;
    const aLoad = unacknowledgedByRecipient.get(a.name)?.size ?? 0;
    const bLoad = unacknowledgedByRecipient.get(b.name)?.size ?? 0;
    return aLoad - bLoad; // tie-break: fewest unacked
  });
  const capable_sorted = pool;
  const target = capable_sorted[0];
  // Re-address to the chosen agent and stamp capability for ACK→pheromone feedback
  message.recipient = target.name;
  message.claimCapability = capability; // enables pheromone reinforcement on ACK
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
        // Reinforce pheromone trail: sender → capability → recipient
        if (message.sender && message.claimCapability) {
          reinforcePheromone(message.sender, message.claimCapability, message.recipient);
        }
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

    // ── Ecosystem feedback loop ──────────────────────────────────────────────
    // When a contract reaches a terminal state, feed the outcome back into
    // SkillScores, Trust and Pheromone trails automatically.
    if (payload.status === 'completed' || payload.status === 'failed') {
      feedbackFromContract(updatedContract, payload.status);
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

// ── Topic Pub/Sub ─────────────────────────────────────────────────────────────

const topicCreateSchema = z.object({
  name: z.string().min(1).max(TOPIC_NAME_MAX_LEN).regex(TOPIC_NAME_RE, 'invalid topic name'),
  description: z.string().max(1000).optional(),
  capability: z.string().min(1).max(64).optional(),
  createdBy: z.string().min(1),
}).strict();

const topicPublishSchema = z.object({
  publisher: z.string().min(1),
  payload: z.unknown(),
}).strict();

const topicSubscribeSchema = z.object({
  agent: z.string().min(1),
}).strict();

app.post('/topics', (req: Request, res: Response) => {
  try {
    const input = topicCreateSchema.parse(req.body);
    const name = input.name.toLowerCase();
    if (topics.has(name)) {
      return sendError(res, 409, `Topic '${name}' already exists`);
    }
    const topic: Topic = {
      name,
      description: input.description,
      capability: input.capability,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    topics.set(name, topic);
    topicSubscriptions.set(name, new Set());
    // Auto-subscribe online agents matching the capability filter
    if (input.capability) {
      for (const agent of listAgentsByCapability(input.capability)) {
        if (agentSockets.has(agent.name)) {
          topicSubscriptions.get(name)!.add(agent.name);
        }
      }
    }
    pushEvent('topic.created', { topic: name, capability: input.capability ?? null, createdBy: input.createdBy });
    res.status(201).json({ success: true, topic });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/topics', (_req: Request, res: Response) => {
  const list = Array.from(topics.values()).map(t => ({
    ...t,
    subscriberCount: topicSubscriptions.get(t.name)?.size ?? 0,
  }));
  res.json({ success: true, topics: list });
});

app.get('/topics/:name', (req: Request, res: Response) => {
  const name = normaliseTopic(req.params.name);
  const topic = topics.get(name);
  if (!topic) return sendError(res, 404, 'Topic not found');
  res.json({
    success: true,
    topic,
    subscribers: Array.from(topicSubscriptions.get(name) ?? []),
  });
});

app.post('/topics/:name/publish', (req: Request, res: Response) => {
  try {
    const name = normaliseTopic(req.params.name);
    if (!topics.has(name)) return sendError(res, 404, 'Topic not found');
    const { publisher, payload } = topicPublishSchema.parse(req.body);
    const delivered = deliverToTopic(name, publisher, payload);
    res.json({ success: true, topic: name, delivered });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.post('/topics/:name/subscribe', (req: Request, res: Response) => {
  try {
    const name = normaliseTopic(req.params.name);
    if (!topics.has(name)) return sendError(res, 404, 'Topic not found');
    const { agent } = topicSubscribeSchema.parse(req.body);
    if (!topicSubscriptions.has(name)) topicSubscriptions.set(name, new Set());
    topicSubscriptions.get(name)!.add(agent);
    res.json({ success: true, topic: name, agent });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.delete('/topics/:name/subscribe/:agent', (req: Request, res: Response) => {
  const name = normaliseTopic(req.params.name);
  if (!topics.has(name)) return sendError(res, 404, 'Topic not found');
  const agent = req.params.agent;
  topicSubscriptions.get(name)?.delete(agent);
  res.json({ success: true, topic: name, agent });
});

// ── Trigger system (Myceliummergi pulse) ──────────────────────────────────────

app.use('/triggers', apiLimiter);
app.use('/webhooks', apiLimiter);

app.post('/triggers', (req: Request, res: Response) => {
  try {
    const input = triggerCreateSchema.parse(req.body);
    const trigger: Trigger = {
      id: generateId(),
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      intervalMs: input.intervalMs,
      action: input.action,
      description: input.description,
      createdAt: new Date().toISOString(),
      fireCount: 0,
    };
    triggers.set(trigger.id, trigger);
    pushEvent('trigger.created', { triggerId: trigger.id, name: trigger.name, type: trigger.type });
    res.status(201).json({ success: true, trigger });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.get('/triggers', (_req: Request, res: Response) => {
  res.json({ success: true, triggers: Array.from(triggers.values()) });
});

app.get('/triggers/:id', (req: Request, res: Response) => {
  const trigger = triggers.get(req.params.id);
  if (!trigger) return sendError(res, 404, 'Trigger not found');
  res.json({ success: true, trigger });
});

app.patch('/triggers/:id', (req: Request, res: Response) => {
  try {
    const trigger = triggers.get(req.params.id);
    if (!trigger) return sendError(res, 404, 'Trigger not found');
    const patch = triggerPatchSchema.parse(req.body);
    if (patch.enabled    !== undefined) trigger.enabled     = patch.enabled;
    if (patch.intervalMs !== undefined) trigger.intervalMs  = patch.intervalMs;
    if (patch.name       !== undefined) trigger.name        = patch.name;
    if (patch.description !== undefined) trigger.description = patch.description;
    if (patch.action     !== undefined) trigger.action      = patch.action;
    res.json({ success: true, trigger });
  } catch (error) {
    handleRouteError(error, res);
  }
});

app.delete('/triggers/:id', (req: Request, res: Response) => {
  if (!triggers.has(req.params.id)) return sendError(res, 404, 'Trigger not found');
  triggers.delete(req.params.id);
  res.json({ success: true });
});

// Manual fire – useful for testing and one-shot triggers
app.post('/triggers/:id/fire', (req: Request, res: Response) => {
  const trigger = triggers.get(req.params.id);
  if (!trigger) return sendError(res, 404, 'Trigger not found');
  fireTrigger(trigger);
  res.json({ success: true, triggerId: trigger.id, fireCount: trigger.fireCount });
});

// Webhook endpoint – external systems POST here to fire a webhook trigger
app.post('/webhooks/:id', (req: Request, res: Response) => {
  const trigger = triggers.get(req.params.id);
  if (!trigger) return sendError(res, 404, 'Trigger not found');
  if (!trigger.enabled) return sendError(res, 409, 'Trigger is disabled');
  if (trigger.type !== 'webhook') return sendError(res, 400, 'Trigger is not a webhook type');
  // Merge incoming body into the action payload for publish_topic actions
  if (trigger.action.type === 'publish_topic' && req.body && typeof req.body === 'object') {
    trigger.action = { ...trigger.action, payload: { ...((trigger.action.payload as object) ?? {}), ...req.body } };
  }
  fireTrigger(trigger);
  res.json({ success: true, triggerId: trigger.id, fireCount: trigger.fireCount });
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
      // Feed consensus outcome back into the ecosystem
      const terminalStatus = result.outcome === 'consensus_approved' ? 'completed' : 'failed';
      feedbackFromContract(contract, terminalStatus);
    }

    res.json({ success: true, contract: serialized, result });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// ── Ecosystem feedback loop ────────────────────────────────────────────────────

/**
 * Called whenever a contract reaches a terminal state (completed / failed).
 * Automatically records experiences, issues rewards, updates trust and
 * reinforces or erodes pheromone trails — no manual calls needed.
 */
function feedbackFromContract(
  contract: import('./contracts').TaskContract,
  terminalStatus: 'completed' | 'failed',
): void {
  const outcome: 'success' | 'failure' = terminalStatus === 'completed' ? 'success' : 'failure';
  // Derive capability from first tag, fall back to 'general'
  const capability = contract.tags[0] ?? 'general';
  const agentName = contract.owner ?? contract.initiator;
  const durationMs = Date.now() - contract.createdAt.getTime();

  // 1. Record experience + auto-reward for the responsible agent
  recordExperience(agentName, capability, contract.title, outcome, durationMs, {
    contractId: contract.id,
    autoReward: true,
  });

  // 2. Update trust between initiator and owner (if different agents)
  if (contract.owner && contract.owner !== contract.initiator) {
    updateTrust(
      contract.initiator,
      contract.owner,
      capability,
      outcome === 'success' ? 'positive' : 'negative',
    );
    // 3. Reinforce or erode pheromone on the initiator→owner path
    if (outcome === 'success') {
      reinforcePheromone(contract.initiator, capability, contract.owner);
    } else {
      erodePheromone(contract.initiator, capability, contract.owner);
    }
  }

  pushEvent('ecosystem.feedback', {
    contractId: contract.id,
    agentName,
    capability,
    outcome,
    durationMs,
  });
}

// ── Adaptive Agent Mesh helpers ───────────────────────────────────────────────

function skillCacheKey(agentName: string, capability: string): string {
  return `${agentName}::${capability}`;
}

function computeTier(score: number, totalJobs: number): AgentTier {
  if (score < -20) return 'rehabilitating';
  if (totalJobs < 5) return 'novice';
  if (score >= 50 && totalJobs >= 10) return 'expert';
  return 'competent';
}

function recomputeSkillScore(agentName: string, capability: string): SkillScore {
  const existing = dbGetSkillScore(agentName, capability) ?? {
    agentName,
    capability,
    successCount: 0,
    failureCount: 0,
    partialCount: 0,
    totalJobs: 0,
    avgDuration: 0,
    endorsements: 0,
    score: 0,
    tier: 'novice' as AgentTier,
    lastUpdated: new Date().toISOString(),
  };
  const { successCount, failureCount, partialCount, totalJobs, endorsements } = existing;
  const raw =
    successCount * 10 +
    partialCount * 3 -
    failureCount * 5 +
    endorsements * 7;
  const score = totalJobs === 0 ? 0 : raw / totalJobs;
  const tier = computeTier(score, totalJobs);
  const updated: SkillScore = { ...existing, score, tier, lastUpdated: new Date().toISOString() };
  dbUpsertSkillScore(updated as PersistedSkillScore);
  skillScoreCache.set(skillCacheKey(agentName, capability), updated);
  return updated;
}

/**
 * Issue a reward, update skill score, and fire SSE events.
 * `capability` may be omitted when the event is not capability-specific.
 */
function issueReward(
  agentName: string,
  reason: RewardReason,
  opts: { capability?: string; contractId?: string; messageId?: string; endorsedBy?: string } = {},
): AgentReward {
  const reward: AgentReward = {
    id: generateId(),
    agentName,
    points: REWARD_POINTS[reason],
    reason,
    contractId: opts.contractId,
    messageId: opts.messageId,
    endorsedBy: opts.endorsedBy,
    timestamp: new Date().toISOString(),
  };
  dbSaveReward(reward);
  pushEvent('agent.reward', { agentName, points: reward.points, reason, totalPoints: dbSumRewardsByAgent(agentName) });

  // Update skill score for this capability if provided
  if (opts.capability) {
    const prev = dbGetSkillScore(agentName, opts.capability);
    const base = prev ?? {
      agentName,
      capability: opts.capability,
      successCount: 0, failureCount: 0, partialCount: 0,
      totalJobs: 0, avgDuration: 0, endorsements: 0,
      score: 0, tier: 'novice' as AgentTier,
      lastUpdated: new Date().toISOString(),
    };
    const next: PersistedSkillScore = {
      ...base,
      successCount: base.successCount + (reason === 'task_completed' ? 1 : 0),
      failureCount: base.failureCount + (reason === 'task_failed' || reason === 'timeout' || reason === 'dlq' ? 1 : 0),
      totalJobs: base.totalJobs + (['task_completed', 'task_failed'].includes(reason) ? 1 : 0),
      endorsements: base.endorsements + (reason === 'peer_endorsed' ? 1 : 0),
    };
    const recomputed = recomputeSkillScore(agentName, opts.capability);
    if (prev && prev.tier !== recomputed.tier) {
      pushEvent('agent.tier_changed', { agentName, capability: opts.capability, from: prev.tier, to: recomputed.tier });
      if (recomputed.tier === 'rehabilitating') {
        pushEvent('agent.rehabilitating', { agentName, score: recomputed.score, capability: opts.capability });
      }
    }
    void next; // used implicitly via recomputeSkillScore
  }

  // Auto-update trust graph based on reward reason
  if (opts.capability && opts.endorsedBy) {
    // Peer endorsement: endorser's trust in agent increases
    updateTrust(opts.endorsedBy, agentName, opts.capability, 'positive');
  } else if (opts.capability && (reason === 'timeout' || reason === 'dlq')) {
    // Failure: sender (if known via messageId lookup) loses trust in agent
    // We record this as a general trust decay — we don't always know the original sender
    // so we note it on the agent's self-edge as a signal for future senders
    pushEvent('trust.reputation_damaged', { agentName, capability: opts.capability, reason });
  }

  return reward;
}

/**
 * Record an experience and update the related skill score counters, then
 * optionally auto-issue a reward.
 */
function recordExperience(
  agentName: string,
  capability: string,
  taskSummary: string,
  outcome: 'success' | 'failure' | 'partial',
  durationMs: number,
  opts: { contractId?: string; messageId?: string; autoReward?: boolean } = {},
): AgentExperience {
  const exp: AgentExperience = {
    id: generateId(),
    agentName,
    capability,
    taskSummary: taskSummary.slice(0, 200),
    outcome,
    durationMs,
    contractId: opts.contractId,
    messageId: opts.messageId,
    endorsements: 0,
    timestamp: new Date().toISOString(),
  };
  dbSaveExperience(exp);

  // Update skill score counters
  const prev = dbGetSkillScore(agentName, capability) ?? {
    agentName, capability,
    successCount: 0, failureCount: 0, partialCount: 0,
    totalJobs: 0, avgDuration: 0, endorsements: 0,
    score: 0, tier: 'novice' as AgentTier,
    lastUpdated: new Date().toISOString(),
  };
  const newTotal = prev.totalJobs + 1;
  const newAvg = (prev.avgDuration * prev.totalJobs + durationMs) / newTotal;
  const updated: PersistedSkillScore = {
    ...prev,
    successCount: prev.successCount + (outcome === 'success' ? 1 : 0),
    failureCount: prev.failureCount + (outcome === 'failure' ? 1 : 0),
    partialCount: prev.partialCount + (outcome === 'partial' ? 1 : 0),
    totalJobs: newTotal,
    avgDuration: newAvg,
  };
  dbUpsertSkillScore(updated);
  const recomputed = recomputeSkillScore(agentName, capability);
  skillScoreCache.set(skillCacheKey(agentName, capability), recomputed);

  if (opts.autoReward) {
    const reason: RewardReason = outcome === 'success'
      ? 'task_completed'
      : outcome === 'failure' ? 'task_failed' : 'task_completed';
    issueReward(agentName, reason, { capability, contractId: opts.contractId, messageId: opts.messageId });
    // Bonus for fast delivery (< 50% of average before this job)
    if (outcome === 'success' && prev.avgDuration > 0 && durationMs < prev.avgDuration * 0.5) {
      issueReward(agentName, 'fast_delivery', { capability });
    }
  }

  return exp;
}

// ── Pheromone helpers ──────────────────────────────────────────────────────────

function pherCacheKey(sender: string, capability: string, receiver: string): string {
  return `${sender}::${capability}::${receiver}`;
}

/**
 * Reinforce a pheromone trail after a successful delivery.
 * Uses additive reinforcement capped at 1.0.
 */
function reinforcePheromone(sender: string, capability: string, receiver: string): PheromoneTrail {
  const key = pherCacheKey(sender, capability, receiver);
  const existing = pheromoneCache.get(key) ?? dbGetPheromoneTrail(sender, capability, receiver);
  const prev = existing?.strength ?? 0;
  const newStrength = Math.min(1.0, prev + PHEROMONE_REINFORCE_DELTA * (1 - prev));
  const trail: PheromoneTrail = {
    sender, capability, receiver,
    strength: newStrength,
    lastReinforced: new Date().toISOString(),
  };
  dbUpsertPheromoneTrail(trail as PersistedPheromoneTrail);
  pheromoneCache.set(key, trail);
  pushEvent('pheromone.reinforced', { sender, capability, receiver, strength: newStrength });
  return trail;
}

/**
 * Erode a trail after a failure — decays faster than natural evaporation.
 */
function erodePheromone(sender: string, capability: string, receiver: string): void {
  const key = pherCacheKey(sender, capability, receiver);
  const existing = pheromoneCache.get(key) ?? dbGetPheromoneTrail(sender, capability, receiver);
  if (!existing) return;
  const newStrength = existing.strength * (PHEROMONE_DECAY_FACTOR ** PHEROMONE_ERODE_FACTOR);
  if (newStrength < PHEROMONE_MIN_STRENGTH) {
    pheromoneCache.delete(key);
    dbClearPheromoneTrails(); // will be cleaned up on next decay cycle
    return;
  }
  const trail: PheromoneTrail = { ...existing, strength: newStrength, lastReinforced: existing.lastReinforced };
  dbUpsertPheromoneTrail(trail as PersistedPheromoneTrail);
  pheromoneCache.set(key, trail);
  pushEvent('pheromone.eroded', { sender, capability, receiver, strength: newStrength });
}

/**
 * Get pheromone strength for a specific path, or undefined if no trail.
 */
function getPheromoneStrength(sender: string, capability: string, receiver: string): number | undefined {
  const key = pherCacheKey(sender, capability, receiver);
  const cached = pheromoneCache.get(key);
  if (cached) return cached.strength;
  const persisted = dbGetPheromoneTrail(sender, capability, receiver);
  if (persisted) {
    pheromoneCache.set(key, persisted);
    return persisted.strength;
  }
  return undefined;
}

// ── Trust graph helpers ────────────────────────────────────────────────────────

function trustCacheKey(from: string, to: string, capability: string): string {
  return `${from}::${to}::${capability}`;
}

/**
 * Update trust that `fromAgent` has in `toAgent` for a given capability.
 * `direction`: 'positive' increases trust, 'negative' decreases it.
 * Uses exponential decay toward limits so trust never reaches exactly 0 or 1.
 */
function updateTrust(
  fromAgent: string,
  toAgent: string,
  capability: string,
  direction: 'positive' | 'negative',
): TrustEdge {
  const key = trustCacheKey(fromAgent, toAgent, capability);
  const existing = trustCache.get(key) ?? dbGetTrustEdge(fromAgent, toAgent, capability);

  const prevScore = existing?.score ?? TRUST_INITIAL_SCORE;
  const delta = direction === 'positive' ? TRUST_POSITIVE_DELTA : -TRUST_NEGATIVE_DELTA;
  // Exponential approach to limit: change is proportional to remaining distance
  const newScore = direction === 'positive'
    ? prevScore + delta * (TRUST_MAX - prevScore)
    : prevScore + delta * (prevScore - TRUST_MIN);
  const clampedScore = Math.max(TRUST_MIN, Math.min(TRUST_MAX, newScore));

  const edge: TrustEdge = {
    fromAgent,
    toAgent,
    capability,
    score: clampedScore,
    interactions: (existing?.interactions ?? 0) + 1,
    lastUpdated: new Date().toISOString(),
  };
  dbUpsertTrustEdge(edge as PersistedTrustEdge);
  trustCache.set(key, edge);
  pushEvent('trust.updated', { fromAgent, toAgent, capability, score: clampedScore, direction });
  return edge;
}

/**
 * Returns trust score from `fromAgent` toward `toAgent` for a capability,
 * or undefined if they have never interacted.
 */
function getTrustScore(fromAgent: string, toAgent: string, capability: string): number | undefined {
  const key = trustCacheKey(fromAgent, toAgent, capability);
  const cached = trustCache.get(key);
  if (cached) return cached.score;
  const persisted = dbGetTrustEdge(fromAgent, toAgent, capability);
  if (persisted) {
    trustCache.set(key, persisted);
    return persisted.score;
  }
  return undefined; // never interacted — unknown, not zero
}

/**
 * Analyse the full trust graph and identify:
 * - isolated: agents no one trusts above threshold
 * - brokers:  agents trusted by many across multiple capabilities
 * - chambers: clusters that only trust each other (echo chambers)
 */
function analyseTrustGraph(threshold = 0.6): {
  isolated: string[];
  brokers: { agent: string; trustedBy: number; capabilities: string[] }[];
  chambers: string[][];
} {
  const edges = dbListAllTrustEdges();

  // Who trusts whom above threshold
  const inbound = new Map<string, Set<string>>(); // toAgent → set of fromAgents
  const capMap  = new Map<string, Set<string>>(); // toAgent → set of capabilities
  for (const e of edges) {
    if (e.score >= threshold) {
      if (!inbound.has(e.toAgent)) inbound.set(e.toAgent, new Set());
      inbound.get(e.toAgent)!.add(e.fromAgent);
      if (!capMap.has(e.toAgent)) capMap.set(e.toAgent, new Set());
      capMap.get(e.toAgent)!.add(e.capability);
    }
  }

  // All agents mentioned in edges
  const allAgents = new Set([...edges.map(e => e.fromAgent), ...edges.map(e => e.toAgent)]);

  // Isolated: no one trusts them above threshold
  const isolated = [...allAgents].filter(a => !inbound.has(a) || inbound.get(a)!.size === 0);

  // Brokers: trusted by many (≥ 3) across multiple capabilities (≥ 2)
  const brokers = [...inbound.entries()]
    .filter(([, trusters]) => trusters.size >= 2)
    .map(([agent, trusters]) => ({
      agent,
      trustedBy: trusters.size,
      capabilities: [...(capMap.get(agent) ?? [])],
    }))
    .sort((a, b) => b.trustedBy - a.trustedBy);

  // Echo chambers: find cliques where members only trust each other
  // Simple approach: find strongly connected components with internal trust only
  const outbound = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.score >= threshold) {
      if (!outbound.has(e.fromAgent)) outbound.set(e.fromAgent, new Set());
      outbound.get(e.fromAgent)!.add(e.toAgent);
    }
  }
  const chambers: string[][] = [];
  const visited = new Set<string>();
  for (const agent of allAgents) {
    if (visited.has(agent)) continue;
    const reachable = new Set<string>();
    const stack = [agent];
    while (stack.length > 0) {
      const curr = stack.pop()!;
      if (reachable.has(curr)) continue;
      reachable.add(curr);
      for (const neighbor of outbound.get(curr) ?? []) stack.push(neighbor);
    }
    // Chamber: all members trust each other AND no one outside trusts them
    if (reachable.size >= 2) {
      const isIsolatedCluster = [...reachable].every(a =>
        [...(inbound.get(a) ?? [])].every(truster => reachable.has(truster))
      );
      if (isIsolatedCluster) {
        for (const a of reachable) visited.add(a);
        chambers.push([...reachable]);
      }
    }
  }

  return { isolated, brokers, chambers };
}

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

// Pheromone evaporation every 10 minutes
const pheromoneDecayTimer = setInterval(() => {
  try {
    dbDecayAllPheromones(PHEROMONE_DECAY_FACTOR);
    // Invalidate cache for trails that may have been pruned
    for (const [key, trail] of pheromoneCache) {
      if (trail.strength * PHEROMONE_DECAY_FACTOR < PHEROMONE_MIN_STRENGTH) {
        pheromoneCache.delete(key);
      } else {
        pheromoneCache.set(key, { ...trail, strength: trail.strength * PHEROMONE_DECAY_FACTOR });
      }
    }
    pushEvent('pheromone.decay_cycle', { factor: PHEROMONE_DECAY_FACTOR, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[pheromone-decay] Error:', err);
  }
}, 10 * 60 * 1000);
pheromoneDecayTimer.unref();

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

// Must be registered before /agents/:name to avoid parametric route shadowing
app.get('/agents/leaderboard', (req: Request, res: Response) => {
  const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;
  const rows = capability
    ? dbListSkillsByCapability(capability)
    : dbListAllSkillScores();

  const byAgent = new Map<string, { agentName: string; totalScore: number; skills: PersistedSkillScore[] }>();
  for (const s of rows) {
    if (!byAgent.has(s.agentName)) byAgent.set(s.agentName, { agentName: s.agentName, totalScore: 0, skills: [] });
    const entry = byAgent.get(s.agentName)!;
    entry.totalScore += s.score;
    entry.skills.push(s);
  }
  const leaderboard = Array.from(byAgent.values())
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((e, i) => ({ rank: i + 1, ...e, totalPoints: dbSumRewardsByAgent(e.agentName) }));

  res.json({ success: true, leaderboard });
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

// ── Adaptive Agent Mesh endpoints ─────────────────────────────────────────────

// Register auth + rate-limit for new routes (done here so middleware order is preserved)
app.use('/agents/:name/experiences', requireApiKey, apiLimiter);
app.use('/agents/:name/endorse', requireApiKey, apiLimiter);
app.use('/agents/:name/skills', requireApiKey, apiLimiter);
app.use('/agents/:name/rewards', requireApiKey, apiLimiter);
app.use('/agents/leaderboard', requireApiKey, apiLimiter);
app.use('/knowledge', requireApiKey, apiLimiter);

const experienceSchema = z.object({
  capability: z.string().min(1).max(64),
  taskSummary: z.string().min(1).max(200),
  outcome: z.enum(['success', 'failure', 'partial']),
  durationMs: z.number().int().min(0).default(0),
  contractId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  autoReward: z.boolean().default(false),
});

const endorseSchema = z.object({
  capability: z.string().min(1).max(64),
  endorsedBy: z.string().min(1).max(64),
  experienceId: z.string().min(1).optional(),
});

// POST /agents/:name/experiences – report an experience (and optionally auto-reward)
app.post('/agents/:name/experiences', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const input = experienceSchema.parse(req.body);
    const exp = recordExperience(
      name,
      input.capability,
      input.taskSummary,
      input.outcome,
      input.durationMs,
      { contractId: input.contractId, messageId: input.messageId, autoReward: input.autoReward },
    );
    res.status(201).json({ success: true, experience: exp });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// GET /agents/:name/experiences – list experiences for an agent
app.get('/agents/:name/experiences', (req: Request, res: Response) => {
  const { name } = req.params;
  const experiences = dbListExperiencesByAgent(name);
  res.json({ success: true, experiences });
});

// POST /agents/:name/endorse – peer endorsement
app.post('/agents/:name/endorse', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const input = endorseSchema.parse(req.body);
    if (input.experienceId) {
      dbIncrementExperienceEndorsements(input.experienceId);
    }
    const reward = issueReward(name, 'peer_endorsed', {
      capability: input.capability,
      endorsedBy: input.endorsedBy,
    });
    // Update endorsements count on the skill score
    const prev = dbGetSkillScore(name, input.capability) ?? {
      agentName: name, capability: input.capability,
      successCount: 0, failureCount: 0, partialCount: 0,
      totalJobs: 0, avgDuration: 0, endorsements: 0,
      score: 0, tier: 'novice' as AgentTier, lastUpdated: new Date().toISOString(),
    };
    dbUpsertSkillScore({ ...prev, endorsements: prev.endorsements + 1, lastUpdated: new Date().toISOString() });
    recomputeSkillScore(name, input.capability);
    pushEvent('agent.endorsed', { agentName: name, capability: input.capability, endorsedBy: input.endorsedBy });
    res.status(201).json({ success: true, reward });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// GET /agents/:name/skills – skill scores for an agent
app.get('/agents/:name/skills', (req: Request, res: Response) => {
  const { name } = req.params;
  const skills = dbListSkillsByAgent(name);
  const totalPoints = dbSumRewardsByAgent(name);
  res.json({ success: true, agentName: name, totalPoints, skills });
});

// GET /agents/:name/rewards – reward history for an agent
app.get('/agents/:name/rewards', (req: Request, res: Response) => {
  const { name } = req.params;
  const rewards = dbListRewardsByAgent(name);
  const totalPoints = dbSumRewardsByAgent(name);
  res.json({ success: true, agentName: name, totalPoints, rewards });
});

// GET /knowledge – query the collective experience library
app.get('/knowledge', (req: Request, res: Response) => {
  const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;
  const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : 'success';
  const limit = Math.min(parseInt(String(req.query.limit ?? '5'), 10) || 5, 50);

  if (!capability) {
    return sendError(res, 400, 'capability query param is required');
  }
  const experiences = dbListExperiencesByCapability(capability, outcome, limit);
  res.json({ success: true, capability, outcome, experiences });
});

// ── Trust graph endpoints ──────────────────────────────────────────────────────

app.use('/trust', requireApiKey, apiLimiter);

const trustUpdateSchema = z.object({
  fromAgent:  z.string().min(1).max(64),
  toAgent:    z.string().min(1).max(64),
  capability: z.string().min(1).max(64),
  direction:  z.enum(['positive', 'negative']),
});

// POST /trust – manually record a trust interaction
app.post('/trust', (req: Request, res: Response) => {
  try {
    const input = trustUpdateSchema.parse(req.body);
    const edge = updateTrust(input.fromAgent, input.toAgent, input.capability, input.direction);
    res.status(201).json({ success: true, edge });
  } catch (error) {
    handleRouteError(error, res);
  }
});

// GET /trust – list all trust edges (optional ?capability= filter)
app.get('/trust', (req: Request, res: Response) => {
  const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;
  const edges = capability
    ? dbListAllTrustEdges().filter(e => e.capability === capability)
    : dbListAllTrustEdges();
  res.json({ success: true, edges });
});

// GET /trust/:from/:to – all trust edges between two specific agents
app.get('/trust/:from/:to', (req: Request, res: Response) => {
  const { from, to } = req.params;
  const all = dbListAllTrustEdges().filter(e => e.fromAgent === from && e.toAgent === to);
  res.json({ success: true, fromAgent: from, toAgent: to, edges: all });
});

// GET /trust/graph – full graph with analysis
app.get('/trust/graph', (req: Request, res: Response) => {
  const threshold = parseFloat(String(req.query.threshold ?? '0.6'));
  const edges = dbListAllTrustEdges();
  const analysis = analyseTrustGraph(isNaN(threshold) ? 0.6 : threshold);

  // Build adjacency list for visualisation
  const nodes = new Set([...edges.map(e => e.fromAgent), ...edges.map(e => e.toAgent)]);
  res.json({
    success: true,
    nodes: [...nodes],
    edges,
    analysis,
  });
});

// ── Pheromone endpoints ────────────────────────────────────────────────────────

app.use('/pheromones', requireApiKey, apiLimiter);

// GET /pheromones – all trails (optional ?capability= filter)
app.get('/pheromones', (req: Request, res: Response) => {
  const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;
  const trails = capability
    ? dbListPheromonesByCapability(capability)
    : dbListAllPheromoneTrails();
  res.json({ success: true, trails });
});

// GET /pheromones/trails/:capability – strongest trails for a capability
app.get('/pheromones/trails/:capability', (req: Request, res: Response) => {
  const { capability } = req.params;
  const trails = dbListPheromonesByCapability(capability);
  // Build leaderboard: which receivers have the strongest collective pheromone for this capability
  const byReceiver = new Map<string, number>();
  for (const t of trails) {
    byReceiver.set(t.receiver, (byReceiver.get(t.receiver) ?? 0) + t.strength);
  }
  const ranked = [...byReceiver.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([receiver, totalStrength], i) => ({ rank: i + 1, receiver, totalStrength }));
  res.json({ success: true, capability, trails, ranked });
});

// POST /pheromones/reinforce – manually reinforce a trail
app.post('/pheromones/reinforce', (req: Request, res: Response) => {
  try {
    const schema = z.object({
      sender: z.string().min(1).max(64),
      capability: z.string().min(1).max(64),
      receiver: z.string().min(1).max(64),
    });
    const { sender, capability, receiver } = schema.parse(req.body);
    const trail = reinforcePheromone(sender, capability, receiver);
    res.status(201).json({ success: true, trail });
  } catch (error) {
    handleRouteError(error, res);
  }
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
  topics.clear();
  topicSubscriptions.clear();
  triggers.clear();
  dlq.clear();
  dbClearDlq();
  traceSpans.clear();
  dbMemoryClearAll();
  skillScoreCache.clear();
  dbClearExperiences();
  dbClearRewards();
  dbClearSkillScores();
  trustCache.clear();
  dbClearTrustEdges();
  pheromoneCache.clear();
  dbClearPheromoneTrails();
}

export function clearConversationHistory(): void {
  conversationHistory.fill(undefined);
  conversationHistoryIndex = 0;
  conversationHistorySize = 0;
}

/** Exported for testing only. */
export { sweepStaleClaims, checkOverdueContracts };

// ── Trigger executor ──────────────────────────────────────────────────────────

/**
 * Executes a trigger's action immediately.
 * Called by the interval loop, webhook endpoint, and manual fire endpoint.
 */
function fireTrigger(trigger: Trigger): void {
  const action = trigger.action;
  try {
    if (action.type === 'publish_message') {
      const content = action.content!;
      const sender  = action.sender!;
      if (action.capability) {
        const queued = queueMessage(`@cap:${action.capability}`, content, sender);
        if (queued.ok) routeByCapability(action.capability, queued.message);
      } else {
        const recipient = action.recipient!;
        const queued = queueMessage(recipient, content, sender);
        if (queued.ok) deliverViaWs(recipient, queued.message);
      }
    } else if (action.type === 'create_contract') {
      createContract({
        title:       action.title!,
        initiator:   action.initiator!,
        priority:    (action.priority as ContractPriority | undefined) ?? 'medium',
        tags:        action.tags ?? (action.capability ? [action.capability] : []),
        files:       [],
        status:      'proposed',
      });
    } else if (action.type === 'publish_topic') {
      const topicName = normaliseTopic(action.topic);
      if (topics.has(topicName)) {
        deliverToTopic(topicName, action.publisher!, action.payload ?? {});
      }
    }

    trigger.lastFiredAt = new Date().toISOString();
    trigger.fireCount++;
    pushEvent('trigger.fired', { triggerId: trigger.id, name: trigger.name, action: action.type });
  } catch (err) {
    console.error(`[trigger] Error firing ${trigger.id} (${trigger.name}):`, err);
    pushEvent('trigger.error', { triggerId: trigger.id, name: trigger.name, error: String(err) });
  }
}

// Interval executor: checks every second which triggers are due
const triggerExecutorTimer = setInterval(() => {
  const now = Date.now();
  for (const trigger of triggers.values()) {
    if (!trigger.enabled || trigger.type !== 'interval') continue;
    const intervalMs = trigger.intervalMs!;
    const lastFired  = trigger.lastFiredAt ? new Date(trigger.lastFiredAt).getTime() : 0;
    if (now - lastFired >= intervalMs) {
      fireTrigger(trigger);
    }
  }
}, 1000);
triggerExecutorTimer.unref();

/** Stop all background timers. Call in afterAll() to prevent Jest open-handle warnings. */
export function stopBackgroundTimers(): void {
  clearInterval(messagePruneTimer);
  clearInterval(claimSweepTimer);
  clearInterval(slaCheckTimer);
  clearInterval(memoryPruneTimer);
  clearInterval(pheromoneDecayTimer);
  clearInterval(triggerExecutorTimer);
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
