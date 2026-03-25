import { z } from 'zod';

// Open-ended capability strings – agents advertise what they can do.
// No fixed enum: any descriptive string is valid (e.g. 'code-analysis', 'security-audit').
export const agentCapabilitySchema = z.string().min(1).max(64);

export const agentRegisterSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  capabilities: z.array(agentCapabilitySchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict();

export type AgentCapability = string;
export type AgentRegisterInput = z.infer<typeof agentRegisterSchema>;

export type AgentStatus = 'online' | 'offline' | 'busy';

export interface RegisteredAgent {
  name: string;
  type: string;
  capabilities: AgentCapability[];
  status: AgentStatus;
  registeredAt: Date;
  lastSeenAt: Date;
  metadata?: Record<string, unknown>;
}

const agents = new Map<string, RegisteredAgent>();

export function registerAgent(input: AgentRegisterInput): RegisteredAgent {
  const now = new Date();
  const existing = agents.get(input.name);
  if (existing) {
    existing.type = input.type;
    existing.capabilities = input.capabilities;
    existing.status = 'online';
    existing.lastSeenAt = now;
    if (input.metadata !== undefined) {
      existing.metadata = input.metadata;
    }
    return existing;
  }

  const agent: RegisteredAgent = {
    name: input.name,
    type: input.type,
    capabilities: input.capabilities,
    status: 'online',
    registeredAt: now,
    lastSeenAt: now,
    metadata: input.metadata
  };

  agents.set(input.name, agent);
  return agent;
}

export function deregisterAgent(name: string): boolean {
  const agent = agents.get(name);
  if (!agent) {
    return false;
  }
  agent.status = 'offline';
  agent.lastSeenAt = new Date();
  return true;
}

export function heartbeatAgent(name: string): boolean {
  const agent = agents.get(name);
  if (!agent) {
    return false;
  }
  agent.lastSeenAt = new Date();
  if (agent.status === 'offline') {
    agent.status = 'online';
  }
  return true;
}

export function setAgentStatus(name: string, status: AgentStatus): boolean {
  const agent = agents.get(name);
  if (!agent) {
    return false;
  }
  agent.status = status;
  agent.lastSeenAt = new Date();
  return true;
}

export function getAgent(name: string): RegisteredAgent | undefined {
  return agents.get(name);
}

export function listAgents(): RegisteredAgent[] {
  return Array.from(agents.values());
}

/**
 * Returns all registered agents that advertise the given capability string.
 * Matching is exact (case-sensitive).
 */
export function listAgentsByCapability(capability: string): RegisteredAgent[] {
  return Array.from(agents.values()).filter(a => a.capabilities.includes(capability));
}

export function serializeAgent(agent: RegisteredAgent): object {
  return {
    name: agent.name,
    type: agent.type,
    capabilities: agent.capabilities,
    status: agent.status,
    registeredAt: agent.registeredAt.toISOString(),
    lastSeenAt: agent.lastSeenAt.toISOString(),
    metadata: agent.metadata
  };
}

export function clearAgentsStore(): void {
  agents.clear();
}
