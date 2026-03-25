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
