/**
 * SQLite persistence layer for unacknowledged messages and dead-letter queue.
 *
 * Messages are written on publish and deleted on ACK. On server restart all
 * rows are loaded back into the in-memory maps so no work is lost.
 *
 * Set BRIDGE_DB_PATH=:memory: (done automatically in Jest via jest.setup.ts)
 * to use an ephemeral in-memory database during tests.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(__dirname, '..', 'data');

function resolveDbPath(): string {
  if (process.env.BRIDGE_DB_PATH) return process.env.BRIDGE_DB_PATH;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, 'bridge.db');
}

const db = new Database(resolveDbPath());
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    sender           TEXT,
    recipient        TEXT NOT NULL,
    content          TEXT NOT NULL,
    timestamp        TEXT NOT NULL,
    contract_id      TEXT,
    trace_id         TEXT,
    claimed_at       TEXT,
    claim_capability TEXT,
    reclaim_count    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient);

  CREATE TABLE IF NOT EXISTS dlq (
    id            TEXT PRIMARY KEY,
    reason        TEXT NOT NULL,
    msg_id        TEXT NOT NULL,
    sender        TEXT,
    recipient     TEXT NOT NULL,
    content       TEXT NOT NULL,
    msg_timestamp TEXT NOT NULL,
    contract_id   TEXT,
    trace_id      TEXT,
    reclaim_count INTEGER NOT NULL DEFAULT 0,
    arrived_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    agent_name  TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    expires_at  TEXT,
    PRIMARY KEY (agent_name, key)
  );
  CREATE INDEX IF NOT EXISTS idx_mem_agent ON agent_memory(agent_name);

  CREATE TABLE IF NOT EXISTS agent_experiences (
    id           TEXT PRIMARY KEY,
    agent_name   TEXT NOT NULL,
    capability   TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    contract_id  TEXT,
    message_id   TEXT,
    endorsements INTEGER NOT NULL DEFAULT 0,
    timestamp    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exp_agent ON agent_experiences(agent_name);
  CREATE INDEX IF NOT EXISTS idx_exp_cap   ON agent_experiences(capability);

  CREATE TABLE IF NOT EXISTS agent_rewards (
    id          TEXT PRIMARY KEY,
    agent_name  TEXT NOT NULL,
    points      INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    contract_id TEXT,
    message_id  TEXT,
    endorsed_by TEXT,
    timestamp   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rew_agent ON agent_rewards(agent_name);

  CREATE TABLE IF NOT EXISTS agent_skill_scores (
    agent_name    TEXT NOT NULL,
    capability    TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    partial_count INTEGER NOT NULL DEFAULT 0,
    total_jobs    INTEGER NOT NULL DEFAULT 0,
    avg_duration  REAL    NOT NULL DEFAULT 0,
    endorsements  INTEGER NOT NULL DEFAULT 0,
    score         REAL    NOT NULL DEFAULT 0,
    tier          TEXT    NOT NULL DEFAULT 'novice',
    last_updated  TEXT    NOT NULL,
    PRIMARY KEY (agent_name, capability)
  );
  CREATE INDEX IF NOT EXISTS idx_skill_agent ON agent_skill_scores(agent_name);
  CREATE INDEX IF NOT EXISTS idx_skill_cap   ON agent_skill_scores(capability);

  CREATE TABLE IF NOT EXISTS trust_edges (
    from_agent   TEXT NOT NULL,
    to_agent     TEXT NOT NULL,
    capability   TEXT NOT NULL,
    score        REAL    NOT NULL DEFAULT 0.5,
    interactions INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT    NOT NULL,
    PRIMARY KEY (from_agent, to_agent, capability)
  );
  CREATE INDEX IF NOT EXISTS idx_trust_from ON trust_edges(from_agent);
  CREATE INDEX IF NOT EXISTS idx_trust_to   ON trust_edges(to_agent);

  CREATE TABLE IF NOT EXISTS pheromone_trails (
    sender      TEXT NOT NULL,
    capability  TEXT NOT NULL,
    receiver    TEXT NOT NULL,
    strength    REAL    NOT NULL DEFAULT 0.0,
    last_reinforced TEXT NOT NULL,
    PRIMARY KEY (sender, capability, receiver)
  );
  CREATE INDEX IF NOT EXISTS idx_pher_cap ON pheromone_trails(capability);
  CREATE INDEX IF NOT EXISTS idx_pher_recv ON pheromone_trails(receiver);
`);

// ── Messages ──────────────────────────────────────────────────────────────────

export interface PersistedMessage {
  id: string;
  sender?: string;
  recipient: string;
  content: string;
  timestamp: string;
  contractId?: string;
  traceId?: string;
  claimedAt?: string;
  claimCapability?: string;
  reclaimCount?: number;
}

const msgStmts = {
  upsert: db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, sender, recipient, content, timestamp, contract_id, trace_id,
       claimed_at, claim_capability, reclaim_count)
    VALUES
      (@id, @sender, @recipient, @content, @timestamp, @contractId, @traceId,
       @claimedAt, @claimCapability, @reclaimCount)
  `),
  delete: db.prepare(`DELETE FROM messages WHERE id = @id`),
  updateClaim: db.prepare(`
    UPDATE messages
    SET recipient = @recipient, claimed_at = @claimedAt,
        claim_capability = @claimCapability, reclaim_count = @reclaimCount
    WHERE id = @id
  `),
  loadAll: db.prepare(`SELECT * FROM messages`),
  deleteAll: db.prepare(`DELETE FROM messages`),
};

/** Persist a new (unacknowledged) message. */
export function dbSaveMessage(msg: PersistedMessage): void {
  msgStmts.upsert.run({
    id: msg.id,
    sender: msg.sender ?? null,
    recipient: msg.recipient,
    content: msg.content,
    timestamp: msg.timestamp,
    contractId: msg.contractId ?? null,
    traceId: msg.traceId ?? null,
    claimedAt: msg.claimedAt ?? null,
    claimCapability: msg.claimCapability ?? null,
    reclaimCount: msg.reclaimCount ?? 0,
  });
}

/** Remove a message once it has been acknowledged. */
export function dbDeleteMessage(id: string): void {
  msgStmts.delete.run({ id });
}

/**
 * Update recipient, claim fields, and reclaim count.
 * Pass null for claimedAt / claimCapability to clear claim state.
 */
export function dbUpdateMessageClaim(
  id: string,
  recipient: string,
  claimedAt: string | null,
  claimCapability: string | null,
  reclaimCount: number,
): void {
  msgStmts.updateClaim.run({ id, recipient, claimedAt, claimCapability, reclaimCount });
}

/** Load all persisted (unacknowledged) messages on startup. */
export function dbLoadAllMessages(): PersistedMessage[] {
  return (msgStmts.loadAll.all() as Record<string, unknown>[]).map(row => ({
    id: row.id as string,
    sender: (row.sender as string | null) ?? undefined,
    recipient: row.recipient as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    contractId: (row.contract_id as string | null) ?? undefined,
    traceId: (row.trace_id as string | null) ?? undefined,
    claimedAt: (row.claimed_at as string | null) ?? undefined,
    claimCapability: (row.claim_capability as string | null) ?? undefined,
    reclaimCount: (row.reclaim_count as number) ?? 0,
  }));
}

/** Wipe all messages – used in tests and clearEventHistory(). */
export function dbClearMessages(): void {
  msgStmts.deleteAll.run();
}

// ── Dead-letter queue ─────────────────────────────────────────────────────────

export interface PersistedDlqEntry {
  id: string;
  reason: string;
  msgId: string;
  sender?: string;
  recipient: string;
  content: string;
  msgTimestamp: string;
  contractId?: string;
  traceId?: string;
  reclaimCount: number;
  arrivedAt: string;
}

const dlqStmts = {
  insert: db.prepare(`
    INSERT INTO dlq
      (id, reason, msg_id, sender, recipient, content, msg_timestamp,
       contract_id, trace_id, reclaim_count, arrived_at)
    VALUES
      (@id, @reason, @msgId, @sender, @recipient, @content, @msgTimestamp,
       @contractId, @traceId, @reclaimCount, @arrivedAt)
  `),
  delete: db.prepare(`DELETE FROM dlq WHERE id = @id`),
  loadAll: db.prepare(`SELECT * FROM dlq ORDER BY arrived_at DESC`),
  deleteAll: db.prepare(`DELETE FROM dlq`),
};

export function dbSaveDlqEntry(entry: PersistedDlqEntry): void {
  dlqStmts.insert.run({
    id: entry.id,
    reason: entry.reason,
    msgId: entry.msgId,
    sender: entry.sender ?? null,
    recipient: entry.recipient,
    content: entry.content,
    msgTimestamp: entry.msgTimestamp,
    contractId: entry.contractId ?? null,
    traceId: entry.traceId ?? null,
    reclaimCount: entry.reclaimCount,
    arrivedAt: entry.arrivedAt,
  });
}

export function dbDeleteDlqEntry(id: string): void {
  dlqStmts.delete.run({ id });
}

export function dbLoadAllDlqEntries(): PersistedDlqEntry[] {
  return (dlqStmts.loadAll.all() as Record<string, unknown>[]).map(row => ({
    id: row.id as string,
    reason: row.reason as string,
    msgId: row.msg_id as string,
    sender: (row.sender as string | null) ?? undefined,
    recipient: row.recipient as string,
    content: row.content as string,
    msgTimestamp: row.msg_timestamp as string,
    contractId: (row.contract_id as string | null) ?? undefined,
    traceId: (row.trace_id as string | null) ?? undefined,
    reclaimCount: row.reclaim_count as number,
    arrivedAt: row.arrived_at as string,
  }));
}

export function dbClearDlq(): void {
  dlqStmts.deleteAll.run();
}

// ── Agent memory ──────────────────────────────────────────────────────────────

export interface PersistedMemoryEntry {
  agentName: string;
  key: string;
  value: string;       // JSON-serialised
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

const memStmts = {
  upsert: db.prepare(`
    INSERT INTO agent_memory (agent_name, key, value, created_at, updated_at, expires_at)
    VALUES (@agentName, @key, @value, @createdAt, @updatedAt, @expiresAt)
    ON CONFLICT(agent_name, key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `),
  get: db.prepare(`
    SELECT * FROM agent_memory WHERE agent_name = @agentName AND key = @key
  `),
  list: db.prepare(`
    SELECT * FROM agent_memory WHERE agent_name = @agentName ORDER BY key
  `),
  delete: db.prepare(`
    DELETE FROM agent_memory WHERE agent_name = @agentName AND key = @key
  `),
  deleteAgent: db.prepare(`
    DELETE FROM agent_memory WHERE agent_name = @agentName
  `),
  deleteExpired: db.prepare(`
    DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < @now
  `),
  deleteAll: db.prepare(`DELETE FROM agent_memory`),
};

export function dbMemorySet(entry: PersistedMemoryEntry): void {
  memStmts.upsert.run({
    agentName: entry.agentName,
    key: entry.key,
    value: entry.value,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt ?? null,
  });
}

export function dbMemoryGet(agentName: string, key: string): PersistedMemoryEntry | undefined {
  const row = memStmts.get.get({ agentName, key }) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    agentName: row.agent_name as string,
    key: row.key as string,
    value: row.value as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  };
}

export function dbMemoryList(agentName: string): PersistedMemoryEntry[] {
  return (memStmts.list.all({ agentName }) as Record<string, unknown>[]).map(row => ({
    agentName: row.agent_name as string,
    key: row.key as string,
    value: row.value as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  }));
}

export function dbMemoryDelete(agentName: string, key: string): boolean {
  const info = memStmts.delete.run({ agentName, key });
  return info.changes > 0;
}

export function dbMemoryDeleteAgent(agentName: string): number {
  const info = memStmts.deleteAgent.run({ agentName });
  return info.changes;
}

export function dbMemoryPruneExpired(): number {
  const info = memStmts.deleteExpired.run({ now: new Date().toISOString() });
  return info.changes;
}

export function dbMemoryClearAll(): void {
  memStmts.deleteAll.run();
}

// ── Agent experiences ──────────────────────────────────────────────────────────

export interface PersistedExperience {
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

const expStmts = {
  insert: db.prepare(`
    INSERT INTO agent_experiences
      (id, agent_name, capability, task_summary, outcome, duration_ms,
       contract_id, message_id, endorsements, timestamp)
    VALUES
      (@id, @agentName, @capability, @taskSummary, @outcome, @durationMs,
       @contractId, @messageId, @endorsements, @timestamp)
  `),
  incrementEndorsements: db.prepare(`
    UPDATE agent_experiences SET endorsements = endorsements + 1
    WHERE id = @id
  `),
  listByAgent: db.prepare(`
    SELECT * FROM agent_experiences WHERE agent_name = @agentName ORDER BY timestamp DESC
  `),
  listByCap: db.prepare(`
    SELECT * FROM agent_experiences
    WHERE capability = @capability AND outcome = @outcome
    ORDER BY timestamp DESC LIMIT @limit
  `),
  deleteAll: db.prepare(`DELETE FROM agent_experiences`),
};

function rowToExperience(row: Record<string, unknown>): PersistedExperience {
  return {
    id: row.id as string,
    agentName: row.agent_name as string,
    capability: row.capability as string,
    taskSummary: row.task_summary as string,
    outcome: row.outcome as 'success' | 'failure' | 'partial',
    durationMs: row.duration_ms as number,
    contractId: (row.contract_id as string | null) ?? undefined,
    messageId: (row.message_id as string | null) ?? undefined,
    endorsements: row.endorsements as number,
    timestamp: row.timestamp as string,
  };
}

export function dbSaveExperience(exp: PersistedExperience): void {
  expStmts.insert.run({
    id: exp.id,
    agentName: exp.agentName,
    capability: exp.capability,
    taskSummary: exp.taskSummary,
    outcome: exp.outcome,
    durationMs: exp.durationMs,
    contractId: exp.contractId ?? null,
    messageId: exp.messageId ?? null,
    endorsements: exp.endorsements,
    timestamp: exp.timestamp,
  });
}

export function dbIncrementExperienceEndorsements(id: string): void {
  expStmts.incrementEndorsements.run({ id });
}

export function dbListExperiencesByAgent(agentName: string): PersistedExperience[] {
  return (expStmts.listByAgent.all({ agentName }) as Record<string, unknown>[]).map(rowToExperience);
}

export function dbListExperiencesByCapability(
  capability: string,
  outcome: string,
  limit: number,
): PersistedExperience[] {
  return (expStmts.listByCap.all({ capability, outcome, limit }) as Record<string, unknown>[]).map(rowToExperience);
}

export function dbClearExperiences(): void {
  expStmts.deleteAll.run();
}

// ── Agent rewards ──────────────────────────────────────────────────────────────

export interface PersistedReward {
  id: string;
  agentName: string;
  points: number;
  reason: string;
  contractId?: string;
  messageId?: string;
  endorsedBy?: string;
  timestamp: string;
}

const rewStmts = {
  insert: db.prepare(`
    INSERT INTO agent_rewards
      (id, agent_name, points, reason, contract_id, message_id, endorsed_by, timestamp)
    VALUES
      (@id, @agentName, @points, @reason, @contractId, @messageId, @endorsedBy, @timestamp)
  `),
  listByAgent: db.prepare(`
    SELECT * FROM agent_rewards WHERE agent_name = @agentName ORDER BY timestamp DESC
  `),
  sumByAgent: db.prepare(`
    SELECT COALESCE(SUM(points), 0) as total FROM agent_rewards WHERE agent_name = @agentName
  `),
  deleteAll: db.prepare(`DELETE FROM agent_rewards`),
};

function rowToReward(row: Record<string, unknown>): PersistedReward {
  return {
    id: row.id as string,
    agentName: row.agent_name as string,
    points: row.points as number,
    reason: row.reason as string,
    contractId: (row.contract_id as string | null) ?? undefined,
    messageId: (row.message_id as string | null) ?? undefined,
    endorsedBy: (row.endorsed_by as string | null) ?? undefined,
    timestamp: row.timestamp as string,
  };
}

export function dbSaveReward(reward: PersistedReward): void {
  rewStmts.insert.run({
    id: reward.id,
    agentName: reward.agentName,
    points: reward.points,
    reason: reward.reason,
    contractId: reward.contractId ?? null,
    messageId: reward.messageId ?? null,
    endorsedBy: reward.endorsedBy ?? null,
    timestamp: reward.timestamp,
  });
}

export function dbListRewardsByAgent(agentName: string): PersistedReward[] {
  return (rewStmts.listByAgent.all({ agentName }) as Record<string, unknown>[]).map(rowToReward);
}

export function dbSumRewardsByAgent(agentName: string): number {
  const row = rewStmts.sumByAgent.get({ agentName }) as Record<string, unknown>;
  return row.total as number;
}

export function dbClearRewards(): void {
  rewStmts.deleteAll.run();
}

// ── Agent skill scores ─────────────────────────────────────────────────────────

export interface PersistedSkillScore {
  agentName: string;
  capability: string;
  successCount: number;
  failureCount: number;
  partialCount: number;
  totalJobs: number;
  avgDuration: number;
  endorsements: number;
  score: number;
  tier: 'novice' | 'competent' | 'expert' | 'rehabilitating';
  lastUpdated: string;
}

const skillStmts = {
  upsert: db.prepare(`
    INSERT INTO agent_skill_scores
      (agent_name, capability, success_count, failure_count, partial_count,
       total_jobs, avg_duration, endorsements, score, tier, last_updated)
    VALUES
      (@agentName, @capability, @successCount, @failureCount, @partialCount,
       @totalJobs, @avgDuration, @endorsements, @score, @tier, @lastUpdated)
    ON CONFLICT(agent_name, capability) DO UPDATE SET
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      partial_count = excluded.partial_count,
      total_jobs    = excluded.total_jobs,
      avg_duration  = excluded.avg_duration,
      endorsements  = excluded.endorsements,
      score         = excluded.score,
      tier          = excluded.tier,
      last_updated  = excluded.last_updated
  `),
  get: db.prepare(`
    SELECT * FROM agent_skill_scores WHERE agent_name = @agentName AND capability = @capability
  `),
  listByAgent: db.prepare(`
    SELECT * FROM agent_skill_scores WHERE agent_name = @agentName ORDER BY score DESC
  `),
  listByCap: db.prepare(`
    SELECT * FROM agent_skill_scores WHERE capability = @capability ORDER BY score DESC
  `),
  listAll: db.prepare(`
    SELECT * FROM agent_skill_scores ORDER BY score DESC
  `),
  deleteAll: db.prepare(`DELETE FROM agent_skill_scores`),
};

function rowToSkill(row: Record<string, unknown>): PersistedSkillScore {
  return {
    agentName: row.agent_name as string,
    capability: row.capability as string,
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    partialCount: row.partial_count as number,
    totalJobs: row.total_jobs as number,
    avgDuration: row.avg_duration as number,
    endorsements: row.endorsements as number,
    score: row.score as number,
    tier: row.tier as PersistedSkillScore['tier'],
    lastUpdated: row.last_updated as string,
  };
}

export function dbUpsertSkillScore(s: PersistedSkillScore): void {
  skillStmts.upsert.run({
    agentName: s.agentName,
    capability: s.capability,
    successCount: s.successCount,
    failureCount: s.failureCount,
    partialCount: s.partialCount,
    totalJobs: s.totalJobs,
    avgDuration: s.avgDuration,
    endorsements: s.endorsements,
    score: s.score,
    tier: s.tier,
    lastUpdated: s.lastUpdated,
  });
}

export function dbGetSkillScore(agentName: string, capability: string): PersistedSkillScore | undefined {
  const row = skillStmts.get.get({ agentName, capability }) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : undefined;
}

export function dbListSkillsByAgent(agentName: string): PersistedSkillScore[] {
  return (skillStmts.listByAgent.all({ agentName }) as Record<string, unknown>[]).map(rowToSkill);
}

export function dbListSkillsByCapability(capability: string): PersistedSkillScore[] {
  return (skillStmts.listByCap.all({ capability }) as Record<string, unknown>[]).map(rowToSkill);
}

export function dbListAllSkillScores(): PersistedSkillScore[] {
  return (skillStmts.listAll.all() as Record<string, unknown>[]).map(rowToSkill);
}

export function dbClearSkillScores(): void {
  skillStmts.deleteAll.run();
}

// ── Trust edges ────────────────────────────────────────────────────────────────

export interface PersistedTrustEdge {
  fromAgent: string;
  toAgent: string;
  capability: string;
  score: number;       // 0.0 – 1.0
  interactions: number;
  lastUpdated: string;
}

const trustStmts = {
  upsert: db.prepare(`
    INSERT INTO trust_edges (from_agent, to_agent, capability, score, interactions, last_updated)
    VALUES (@fromAgent, @toAgent, @capability, @score, @interactions, @lastUpdated)
    ON CONFLICT(from_agent, to_agent, capability) DO UPDATE SET
      score        = excluded.score,
      interactions = excluded.interactions,
      last_updated = excluded.last_updated
  `),
  get: db.prepare(`
    SELECT * FROM trust_edges
    WHERE from_agent = @fromAgent AND to_agent = @toAgent AND capability = @capability
  `),
  listFrom: db.prepare(`
    SELECT * FROM trust_edges WHERE from_agent = @fromAgent ORDER BY score DESC
  `),
  listTo: db.prepare(`
    SELECT * FROM trust_edges WHERE to_agent = @toAgent ORDER BY score DESC
  `),
  listByCap: db.prepare(`
    SELECT * FROM trust_edges WHERE capability = @capability ORDER BY score DESC
  `),
  listAll: db.prepare(`SELECT * FROM trust_edges`),
  deleteAll: db.prepare(`DELETE FROM trust_edges`),
};

function rowToTrust(row: Record<string, unknown>): PersistedTrustEdge {
  return {
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    capability: row.capability as string,
    score: row.score as number,
    interactions: row.interactions as number,
    lastUpdated: row.last_updated as string,
  };
}

export function dbUpsertTrustEdge(edge: PersistedTrustEdge): void {
  trustStmts.upsert.run({
    fromAgent: edge.fromAgent,
    toAgent: edge.toAgent,
    capability: edge.capability,
    score: edge.score,
    interactions: edge.interactions,
    lastUpdated: edge.lastUpdated,
  });
}

export function dbGetTrustEdge(
  fromAgent: string,
  toAgent: string,
  capability: string,
): PersistedTrustEdge | undefined {
  const row = trustStmts.get.get({ fromAgent, toAgent, capability }) as Record<string, unknown> | undefined;
  return row ? rowToTrust(row) : undefined;
}

export function dbListTrustFrom(fromAgent: string): PersistedTrustEdge[] {
  return (trustStmts.listFrom.all({ fromAgent }) as Record<string, unknown>[]).map(rowToTrust);
}

export function dbListTrustTo(toAgent: string): PersistedTrustEdge[] {
  return (trustStmts.listTo.all({ toAgent }) as Record<string, unknown>[]).map(rowToTrust);
}

export function dbListTrustByCapability(capability: string): PersistedTrustEdge[] {
  return (trustStmts.listByCap.all({ capability }) as Record<string, unknown>[]).map(rowToTrust);
}

export function dbListAllTrustEdges(): PersistedTrustEdge[] {
  return (trustStmts.listAll.all() as Record<string, unknown>[]).map(rowToTrust);
}

export function dbClearTrustEdges(): void {
  trustStmts.deleteAll.run();
}

// ── Pheromone trails ───────────────────────────────────────────────────────────

export interface PersistedPheromoneTrail {
  sender: string;
  capability: string;
  receiver: string;
  strength: number;    // 0.0 – 1.0
  lastReinforced: string;
}

const pherStmts = {
  upsert: db.prepare(`
    INSERT INTO pheromone_trails (sender, capability, receiver, strength, last_reinforced)
    VALUES (@sender, @capability, @receiver, @strength, @lastReinforced)
    ON CONFLICT(sender, capability, receiver) DO UPDATE SET
      strength       = excluded.strength,
      last_reinforced = excluded.last_reinforced
  `),
  get: db.prepare(`
    SELECT * FROM pheromone_trails
    WHERE sender = @sender AND capability = @capability AND receiver = @receiver
  `),
  listByCap: db.prepare(`
    SELECT * FROM pheromone_trails WHERE capability = @capability ORDER BY strength DESC
  `),
  listAll: db.prepare(`SELECT * FROM pheromone_trails ORDER BY strength DESC`),
  decayAll: db.prepare(`
    UPDATE pheromone_trails SET strength = strength * @factor
  `),
  deleteweak: db.prepare(`DELETE FROM pheromone_trails WHERE strength < @threshold`),
  deleteAll: db.prepare(`DELETE FROM pheromone_trails`),
};

function rowToPheromone(row: Record<string, unknown>): PersistedPheromoneTrail {
  return {
    sender: row.sender as string,
    capability: row.capability as string,
    receiver: row.receiver as string,
    strength: row.strength as number,
    lastReinforced: row.last_reinforced as string,
  };
}

export function dbUpsertPheromoneTrail(trail: PersistedPheromoneTrail): void {
  pherStmts.upsert.run({
    sender: trail.sender,
    capability: trail.capability,
    receiver: trail.receiver,
    strength: Math.max(0, Math.min(1, trail.strength)),
    lastReinforced: trail.lastReinforced,
  });
}

export function dbGetPheromoneTrail(
  sender: string,
  capability: string,
  receiver: string,
): PersistedPheromoneTrail | undefined {
  const row = pherStmts.get.get({ sender, capability, receiver }) as Record<string, unknown> | undefined;
  return row ? rowToPheromone(row) : undefined;
}

export function dbListPheromonesByCapability(capability: string): PersistedPheromoneTrail[] {
  return (pherStmts.listByCap.all({ capability }) as Record<string, unknown>[]).map(rowToPheromone);
}

export function dbListAllPheromoneTrails(): PersistedPheromoneTrail[] {
  return (pherStmts.listAll.all() as Record<string, unknown>[]).map(rowToPheromone);
}

export function dbDecayAllPheromones(factor: number): void {
  pherStmts.decayAll.run({ factor });
  pherStmts.deleteweak.run({ threshold: 0.01 });
}

export function dbClearPheromoneTrails(): void {
  pherStmts.deleteAll.run();
}
