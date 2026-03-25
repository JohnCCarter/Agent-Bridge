/**
 * SQLite persistence layer for unacknowledged messages.
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
    claimed_at       TEXT,
    claim_capability TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient);
`);

export interface PersistedMessage {
  id: string;
  sender?: string;
  recipient: string;
  content: string;
  timestamp: string;
  contractId?: string;
  claimedAt?: string;
  claimCapability?: string;
}

const stmts = {
  upsert: db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, sender, recipient, content, timestamp, contract_id, claimed_at, claim_capability)
    VALUES
      (@id, @sender, @recipient, @content, @timestamp, @contractId, @claimedAt, @claimCapability)
  `),
  delete: db.prepare(`DELETE FROM messages WHERE id = @id`),
  updateClaim: db.prepare(`
    UPDATE messages
    SET recipient = @recipient, claimed_at = @claimedAt, claim_capability = @claimCapability
    WHERE id = @id
  `),
  loadAll: db.prepare(`SELECT * FROM messages`),
  deleteAll: db.prepare(`DELETE FROM messages`),
};

/** Persist a new (unacknowledged) message. */
export function dbSaveMessage(msg: PersistedMessage): void {
  stmts.upsert.run({
    id: msg.id,
    sender: msg.sender ?? null,
    recipient: msg.recipient,
    content: msg.content,
    timestamp: msg.timestamp,
    contractId: msg.contractId ?? null,
    claimedAt: msg.claimedAt ?? null,
    claimCapability: msg.claimCapability ?? null,
  });
}

/** Remove a message once it has been acknowledged. */
export function dbDeleteMessage(id: string): void {
  stmts.delete.run({ id });
}

/**
 * Update recipient and claim fields when a message is claimed or reclaimed.
 * Pass null for claimedAt / claimCapability to clear claim state.
 */
export function dbUpdateMessageClaim(
  id: string,
  recipient: string,
  claimedAt: string | null,
  claimCapability: string | null,
): void {
  stmts.updateClaim.run({ id, recipient, claimedAt, claimCapability });
}

/** Load all persisted (unacknowledged) messages on startup. */
export function dbLoadAllMessages(): PersistedMessage[] {
  return (stmts.loadAll.all() as Record<string, unknown>[]).map(row => ({
    id: row.id as string,
    sender: (row.sender as string | null) ?? undefined,
    recipient: row.recipient as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    contractId: (row.contract_id as string | null) ?? undefined,
    claimedAt: (row.claimed_at as string | null) ?? undefined,
    claimCapability: (row.claim_capability as string | null) ?? undefined,
  }));
}

/** Wipe all messages – used in tests and clearEventHistory(). */
export function dbClearMessages(): void {
  stmts.deleteAll.run();
}
