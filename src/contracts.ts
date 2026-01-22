import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
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
  relatedMessageId: z.string().optional()
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
}).superRefine((data, ctx) => {
  const hasUpdatableField = data.status !== undefined ||
    data.owner !== undefined ||
    data.note !== undefined ||
    data.metadata !== undefined ||
    data.tags !== undefined ||
    data.files !== undefined ||
    data.dueAt !== undefined;

  if (!hasUpdatableField) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "No fields provided for update"
    });
  }
});

export type ContractStatus = z.infer<typeof contractStatusSchema>;
export type ContractPriority = z.infer<typeof contractPrioritySchema>;
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
  history: ContractHistoryEntry[];
}

export interface SerializedContract extends Omit<TaskContract, "createdAt" | "updatedAt" | "dueAt" | "history" | "metadata"> {
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
  history: Array<Omit<ContractHistoryEntry, "timestamp"> & { timestamp: string }>;
}

const contracts = new Map<string, TaskContract>();

const DATA_DIR = path.join(__dirname, "..", "data");
const CONTRACTS_FILE = path.join(DATA_DIR, "contracts.json");

// Debounce config for batching writes
let persistTimer: NodeJS.Timeout | null = null;
let persistPending = false;
const PERSIST_DEBOUNCE_MS = 1000; // 1 second debounce

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
    history: serialized.history.map(entry => ({
      id: entry.id,
      timestamp: new Date(entry.timestamp),
      actor: entry.actor,
      status: entry.status,
      note: entry.note
    }))
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
  
  persistTimer = setTimeout(async () => {
    if (!persistPending) return;
    
    try {
      ensureDataDir();
      const serialized = Array.from(contracts.values()).map(serializeContract);
      await fsPromises.writeFile(CONTRACTS_FILE, JSON.stringify(serialized, null, 2), "utf8");
      persistPending = false;
    } catch (error) {
      console.error("Failed to persist contracts:", error);
      // Retry after a delay
      persistTimer = setTimeout(() => persistContracts(), 5000);
    }
  }, PERSIST_DEBOUNCE_MS);
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
    history: [historyEntry]
  };

  contracts.set(contract.id, contract);
  persistContracts();
  return contract;
}

export function getContract(id: string): TaskContract | undefined {
  return contracts.get(id);
}

export function updateContract(id: string, update: ContractUpdateInput): TaskContract | undefined {
  const contract = contracts.get(id);
  if (!contract) {
    return undefined;
  }

  const now = new Date();
  let statusChanged = false;

  if (update.status && update.status !== contract.status) {
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
    history: contract.history.map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      actor: entry.actor,
      status: entry.status,
      note: entry.note
    }))
  };
}

export function clearContractsStore(): void {
  contracts.clear();
  persistContracts();
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

loadContractsFromDisk();
