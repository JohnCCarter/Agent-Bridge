import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import crypto from "crypto";
import { z } from "zod";

export const contractStatusSchema = z.enum([
  "proposed",
  "accepted",
  "in_progress",
  "completed",
  "failed",
  "cancelled"
]);

export const contractPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical"
]);

export const contractCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().max(4000).optional(),
  initiator: z.string().min(1),
  owner: z.string().min(1).optional(),
  status: contractStatusSchema.default("proposed"),
  priority: contractPrioritySchema.default("medium"),
  tags: z.array(z.string().min(1)).default([]),
  files: z.array(z.string().min(1)).default([]),
  dueAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  relatedMessageId: z.string().optional(),
  parentId: z.string().optional(),
  traceId: z.string().optional(),
  votingPolicy: z.object({
    requiredApprovals: z.number().int().min(1),
    totalVoters: z.number().int().min(1),
  }).optional(),
}).strict();

export const contractUpdateSchema = z.object({
  actor: z.string().min(1),
  status: contractStatusSchema.optional(),
  owner: z.string().min(1).nullable().optional(),
  note: z.string().max(4000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  files: z.array(z.string().min(1)).optional(),
  dueAt: z.string().datetime().nullable().optional()
}).superRefine((updateData, ctx) => {
  const hasUpdatableField = updateData.status !== undefined ||
    updateData.owner !== undefined ||
    updateData.note !== undefined ||
    updateData.metadata !== undefined ||
    updateData.tags !== undefined ||
    updateData.files !== undefined ||
    updateData.dueAt !== undefined;

  if (!hasUpdatableField) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "No fields provided for update"
    });
  }
});

export type ContractStatus = z.infer<typeof contractStatusSchema>;
export type ContractPriority = z.infer<typeof contractPrioritySchema>;

export const contractVoteSchema = z.object({
  voter: z.string().min(1),
  verdict: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
}).strict();

export type ContractVoteInput = z.infer<typeof contractVoteSchema>;

export interface ContractVote {
  id: string;
  voter: string;
  verdict: 'approve' | 'reject';
  note?: string;
  timestamp: Date;
}

export interface VotingPolicy {
  requiredApprovals: number;
  totalVoters: number;
}

// Valid state-machine transitions: from → allowed targets
const VALID_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  proposed:    ['accepted', 'cancelled'],
  accepted:    ['in_progress', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed:   [],
  failed:      ['in_progress'],   // allow retry
  cancelled:   [],
};

export function isValidTransition(from: ContractStatus, to: ContractStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
export type ContractCreateInput = z.infer<typeof contractCreateSchema>;
export type ContractUpdateInput = z.infer<typeof contractUpdateSchema>;

export interface ContractHistoryEntry {
  id: string;
  timestamp: Date;
  actor: string;
  status: ContractStatus;
  note?: string;
}

export interface TaskContract {
  id: string;
  title: string;
  description?: string;
  initiator: string;
  owner?: string;
  status: ContractStatus;
  priority: ContractPriority;
  tags: string[];
  files: string[];
  createdAt: Date;
  updatedAt: Date;
  dueAt?: Date;
  metadata?: Record<string, unknown>;
  relatedMessageId?: string;
  parentId?: string;
  childIds: string[];
  history: ContractHistoryEntry[];
  traceId?: string;
  votes: ContractVote[];
  votingPolicy?: VotingPolicy;
}

export interface SerializedContract extends Omit<TaskContract, "createdAt" | "updatedAt" | "dueAt" | "history" | "metadata" | "votes"> {
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
  parentId?: string;
  childIds: string[];
  history: Array<Omit<ContractHistoryEntry, "timestamp"> & { timestamp: string }>;
  votes: Array<Omit<ContractVote, "timestamp"> & { timestamp: string }>;
}

const contracts = new Map<string, TaskContract>();

const DATA_DIR = path.join(__dirname, "..", "data");
const CONTRACTS_FILE = path.join(DATA_DIR, "contracts.json");

// Debounce config for batching writes
let persistTimer: NodeJS.Timeout | null = null;
let persistPending = false;
let persistRetryCount = 0;
const PERSIST_DEBOUNCE_MS = 1000; // 1 second debounce
const MAX_PERSIST_RETRIES = 3;

function generateId(): string {
  return crypto.randomUUID();
}

function toDate(value?: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function deserializeContract(serialized: SerializedContract): TaskContract {
  return {
    id: serialized.id,
    title: serialized.title,
    description: serialized.description,
    initiator: serialized.initiator,
    owner: serialized.owner,
    status: serialized.status,
    priority: serialized.priority,
    tags: serialized.tags,
    files: serialized.files,
    createdAt: new Date(serialized.createdAt),
    updatedAt: new Date(serialized.updatedAt),
    dueAt: serialized.dueAt ? new Date(serialized.dueAt) : undefined,
    metadata: serialized.metadata,
    relatedMessageId: serialized.relatedMessageId,
    parentId: serialized.parentId,
    childIds: serialized.childIds ?? [],
    history: serialized.history.map(entry => ({
      id: entry.id,
      timestamp: new Date(entry.timestamp),
      actor: entry.actor,
      status: entry.status,
      note: entry.note
    })),
    traceId: serialized.traceId,
    votes: (serialized.votes ?? []).map(v => ({
      id: v.id,
      voter: v.voter,
      verdict: v.verdict,
      note: v.note,
      timestamp: new Date(v.timestamp),
    })),
    votingPolicy: serialized.votingPolicy,
  };
}

/**
 * Persists contracts to disk asynchronously with debouncing.
 * Multiple rapid updates within PERSIST_DEBOUNCE_MS are batched into a single write.
 */
function persistContracts(): void {
  persistPending = true;
  
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  
  const t = setTimeout(async () => {
    if (!persistPending) return;

    try {
      ensureDataDir();
      const serialized = Array.from(contracts.values()).map(serializeContract);
      await fsPromises.writeFile(CONTRACTS_FILE, JSON.stringify(serialized, null, 2), "utf8");
      persistPending = false;
      persistRetryCount = 0; // Reset retry count on success
    } catch (error) {
      console.error("Failed to persist contracts:", error);

      // Retry with exponential backoff, up to MAX_PERSIST_RETRIES
      if (persistRetryCount < MAX_PERSIST_RETRIES) {
        persistRetryCount++;
        const retryDelay = 1000 * Math.pow(2, persistRetryCount); // 2s, 4s, 8s
        console.log(`Retrying persist in ${retryDelay}ms (attempt ${persistRetryCount}/${MAX_PERSIST_RETRIES})`);
        persistTimer = setTimeout(() => persistContracts(), retryDelay);
        persistTimer.unref();
      } else {
        console.error(`Failed to persist after ${MAX_PERSIST_RETRIES} retries. Giving up.`);
        persistPending = false;
        persistRetryCount = 0;
      }
    }
  }, PERSIST_DEBOUNCE_MS);
  t.unref();
  persistTimer = t;
}

function loadContractsFromDisk(): void {
  try {
    ensureDataDir();
    if (!fs.existsSync(CONTRACTS_FILE)) {
      return;
    }
    const raw = fs.readFileSync(CONTRACTS_FILE, "utf8");
    if (!raw.trim()) {
      return;
    }
    const parsed: SerializedContract[] = JSON.parse(raw);
    contracts.clear();
    parsed.forEach(serialized => {
      const contract = deserializeContract(serialized);
      contracts.set(contract.id, contract);
    });
  } catch (error) {
    console.error("Failed to load contracts from disk:", error);
  }
}

export function createContract(input: ContractCreateInput): TaskContract {
  const now = new Date();
  const historyEntry: ContractHistoryEntry = {
    id: generateId(),
    timestamp: now,
    actor: input.initiator,
    status: input.status,
    note: "Contract created"
  };

  const contract: TaskContract = {
    id: generateId(),
    title: input.title,
    description: input.description,
    initiator: input.initiator,
    owner: input.owner,
    status: input.status,
    priority: input.priority,
    tags: input.tags,
    files: input.files,
    createdAt: now,
    updatedAt: now,
    dueAt: toDate(input.dueAt),
    metadata: input.metadata,
    relatedMessageId: input.relatedMessageId,
    parentId: input.parentId,
    childIds: [],
    history: [historyEntry],
    traceId: input.traceId,
    votes: [],
    votingPolicy: input.votingPolicy,
  };

  contracts.set(contract.id, contract);

  // If this is a child contract, register it with the parent
  if (input.parentId) {
    const parent = contracts.get(input.parentId);
    if (parent) {
      parent.childIds.push(contract.id);
      parent.updatedAt = now;
    }
  }

  persistContracts();
  return contract;
}

export function getContract(id: string): TaskContract | undefined {
  return contracts.get(id);
}

export function listContracts(): TaskContract[] {
  return Array.from(contracts.values());
}

export function updateContract(id: string, update: ContractUpdateInput): TaskContract | undefined {
  const contract = contracts.get(id);
  if (!contract) {
    return undefined;
  }

  const now = new Date();
  let statusChanged = false;

  if (update.status && update.status !== contract.status) {
    if (!isValidTransition(contract.status, update.status)) {
      throw new Error(`Invalid status transition: ${contract.status} → ${update.status}`);
    }
    contract.status = update.status;
    statusChanged = true;
  }

  if (update.owner !== undefined) {
    contract.owner = update.owner === null ? undefined : update.owner;
  }

  if (update.tags) {
    contract.tags = update.tags;
  }

  if (update.files) {
    contract.files = update.files;
  }

  if (update.metadata) {
    contract.metadata = {
      ...(contract.metadata || {}),
      ...update.metadata
    };
  }

  if (update.dueAt !== undefined) {
    contract.dueAt = update.dueAt === null ? undefined : toDate(update.dueAt);
  }

  contract.updatedAt = now;

  if (statusChanged || update.note) {
    contract.history.push({
      id: generateId(),
      timestamp: now,
      actor: update.actor,
      status: contract.status,
      note: update.note
    });
  }

  persistContracts();
  return contract;
}

export function serializeContract(contract: TaskContract): SerializedContract {
  return {
    id: contract.id,
    title: contract.title,
    description: contract.description,
    initiator: contract.initiator,
    owner: contract.owner,
    status: contract.status,
    priority: contract.priority,
    tags: contract.tags,
    files: contract.files,
    createdAt: contract.createdAt.toISOString(),
    updatedAt: contract.updatedAt.toISOString(),
    dueAt: contract.dueAt ? contract.dueAt.toISOString() : undefined,
    metadata: contract.metadata,
    relatedMessageId: contract.relatedMessageId,
    parentId: contract.parentId,
    childIds: contract.childIds,
    history: contract.history.map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      actor: entry.actor,
      status: entry.status,
      note: entry.note
    })),
    traceId: contract.traceId,
    votes: contract.votes.map(v => ({
      id: v.id,
      voter: v.voter,
      verdict: v.verdict,
      note: v.note,
      timestamp: v.timestamp.toISOString(),
    })),
    votingPolicy: contract.votingPolicy,
  };
}

/**
 * Creates a sub-contract (child task) under an existing parent contract.
 * Returns undefined if the parent contract does not exist.
 */
export function createSubContract(
  parentId: string,
  input: ContractCreateInput
): TaskContract | undefined {
  if (!contracts.get(parentId)) {
    return undefined;
  }
  return createContract({ ...input, parentId });
}

export type VoteResult =
  | { outcome: 'vote_recorded'; approvals: number; rejections: number; required: number }
  | { outcome: 'consensus_approved' }
  | { outcome: 'consensus_rejected' }
  | { outcome: 'no_policy' };

/**
 * Cast a vote on a contract.  Returns the outcome so callers can push events.
 * Throws if the contract doesn't exist, is in a terminal state, or the voter
 * has already voted.
 */
export function voteOnContract(
  contractId: string,
  input: ContractVoteInput,
): { contract: TaskContract; result: VoteResult } {
  const contract = contracts.get(contractId);
  if (!contract) throw new Error(`Contract ${contractId} not found`);

  const terminal: ContractStatus[] = ['completed', 'failed', 'cancelled'];
  if (terminal.includes(contract.status)) {
    throw new Error(`Cannot vote on a ${contract.status} contract`);
  }
  if (contract.votes.some(v => v.voter === input.voter)) {
    throw new Error(`${input.voter} has already voted on this contract`);
  }

  const vote: ContractVote = {
    id: generateId(),
    voter: input.voter,
    verdict: input.verdict,
    note: input.note,
    timestamp: new Date(),
  };
  contract.votes.push(vote);
  contract.updatedAt = new Date();

  if (!contract.votingPolicy) {
    persistContracts();
    return { contract, result: { outcome: 'no_policy' } };
  }

  const approvals = contract.votes.filter(v => v.verdict === 'approve').length;
  const rejections = contract.votes.filter(v => v.verdict === 'reject').length;
  const { requiredApprovals, totalVoters } = contract.votingPolicy;
  const impossibleToApprove = totalVoters - rejections < requiredApprovals;

  if (approvals >= requiredApprovals) {
    // Auto-transition to completed (follow state machine: may need intermediate steps)
    if (contract.status === 'proposed') contract.status = 'accepted';
    if (contract.status === 'accepted') contract.status = 'in_progress';
    contract.status = 'completed';
    contract.history.push({
      id: generateId(),
      timestamp: new Date(),
      actor: 'voting-system',
      status: 'completed',
      note: `Consensus reached: ${approvals}/${totalVoters} approved`,
    });
    persistContracts();
    return { contract, result: { outcome: 'consensus_approved' } };
  }

  if (impossibleToApprove) {
    if (contract.status === 'proposed') contract.status = 'accepted';
    if (contract.status === 'accepted') contract.status = 'in_progress';
    contract.status = 'failed';
    contract.history.push({
      id: generateId(),
      timestamp: new Date(),
      actor: 'voting-system',
      status: 'failed',
      note: `Consensus failed: ${rejections} rejection(s) make approval impossible`,
    });
    persistContracts();
    return { contract, result: { outcome: 'consensus_rejected' } };
  }

  persistContracts();
  return { contract, result: { outcome: 'vote_recorded', approvals, rejections, required: requiredApprovals } };
}

export interface SlaViolation {
  contractId: string;
  title: string;
  status: ContractStatus;
  dueAt: Date;
  overdueMs: number;
}

const TERMINAL_STATUSES: ContractStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Returns all active contracts whose dueAt has passed.
 * Terminal contracts (completed/failed/cancelled) are excluded.
 */
export function checkOverdueContracts(): SlaViolation[] {
  const now = Date.now();
  const violations: SlaViolation[] = [];
  for (const contract of contracts.values()) {
    if (!contract.dueAt) continue;
    if (TERMINAL_STATUSES.includes(contract.status)) continue;
    const overdueMs = now - contract.dueAt.getTime();
    if (overdueMs <= 0) continue;
    violations.push({
      contractId: contract.id,
      title: contract.title,
      status: contract.status,
      dueAt: contract.dueAt,
      overdueMs,
    });
  }
  return violations;
}

export function clearContractsStore(): void {
  contracts.clear();
  // Cancel any pending persist – no need to write an empty store during tests
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistPending = false;
}

export function attachMessageToContract(contractId: string, messageId: string): void {
  const contract = contracts.get(contractId);
  if (!contract) {
    return;
  }

  if (!contract.relatedMessageId) {
    contract.relatedMessageId = messageId;
    persistContracts();
  }
}

/**
 * Flushes pending contract persistence immediately (for testing).
 * Returns a promise that resolves when persistence is complete.
 */
export async function flushContractPersistence(): Promise<void> {
  if (!persistPending) return;
  
  // Clear any pending timer and persist immediately
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  
  try {
    ensureDataDir();
    const serialized = Array.from(contracts.values()).map(serializeContract);
    await fsPromises.writeFile(CONTRACTS_FILE, JSON.stringify(serialized, null, 2), "utf8");
    persistPending = false;
    persistRetryCount = 0;
  } catch (error) {
    console.error("Failed to flush contract persistence:", error);
    throw error;
  }
}

loadContractsFromDisk();
