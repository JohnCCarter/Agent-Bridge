import { z } from 'zod';

const planItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
  owner: z.string().optional(),
  details: z.string().optional()
});

const actionSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  intent: z.string().optional(),
  expectedOutcome: z.string().optional()
});

const diffSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
  patch: z.string().optional()
});

const artifactSchema = z.object({
  path: z.string().min(1),
  type: z.string().default('file'),
  description: z.string().optional()
});

const checkSchema = z.object({
  kind: z.enum(['tests', 'lint', 'review', 'verification', 'custom']).default('custom'),
  description: z.string().optional(),
  status: z.enum(['pending', 'running', 'passed', 'failed']).default('pending'),
  command: z.string().optional()
});

const handoffSchema = z.enum(['analyst', 'implementer', 'verifier', 'complete']);

const agentEnvelopeSchema = z.object({
  role: z.enum(['Cursor-analytiker', 'Codex-implementerare', 'Verifierare']),
  phase: z.enum(['analysis', 'implementation', 'verification']).default('analysis'),
  summary: z.string().default(''),
  status: z.enum(['pending', 'in_progress', 'blocked', 'done']).default('done'),
  plan: z.array(planItemSchema).default([]),
  actions: z.array(actionSchema).default([]),
  diffs: z.array(diffSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  checks: z.array(checkSchema).default([]),
  notes: z.array(z.string()).default([]),
  handoff: handoffSchema.default('complete'),
  telemetry: z.record(z.string(), z.unknown()).default({})
});

function formatPlan(plan = []) {
  if (!plan.length) return 'No plan supplied.';
  return plan.map(planItem => `- [${planItem.status}] ${planItem.title}${planItem.owner ? ` (owner: ${planItem.owner})` : ''}${planItem.details ? ` — ${planItem.details}` : ''}`).join('\n');
}

function formatActions(actions = []) {
  if (!actions.length) return 'No actions specified.';
  return actions.map(action => `- ${action.command}${action.args?.length ? ` ${action.args.join(' ')}` : ''}${action.intent ? ` (${action.intent})` : ''}`).join('\n');
}

function formatEnvelopeSummary(envelope) {
  const { summary, plan, actions, handoff, status, phase } = envelope;
  const blocks = [
    `Summary (${phase}): ${summary || 'n/a'}`,
    `Status: ${status} → Handoff: ${handoff}`,
    'Plan:',
    formatPlan(plan),
    'Actions:',
    formatActions(actions)
  ];
  return blocks.join('\n');
}

function normalizeAgentExchange(payload, options = {}) {
  const { defaultRole = 'Cursor-analytiker', defaultHandoff = 'complete', defaultSummary = 'No summary provided' } = options;
  const envelopeInput = payload?.envelope || {};
  const envelope = agentEnvelopeSchema.parse({
    role: payload?.role || envelopeInput.role || defaultRole,
    handoff: envelopeInput.handoff || defaultHandoff,
    summary: payload?.content || envelopeInput.summary || defaultSummary,
    ...envelopeInput
  });

  const content = payload?.content || formatEnvelopeSummary(envelope);

  return {
    ...payload,
    role: envelope.role,
    content,
    envelope
  };
}

function createInitialEnvelope(task) {
  return {
    role: 'Cursor-analytiker',
    phase: 'analysis',
    summary: `Initial analysis request for task: ${task}`,
    status: 'pending',
    plan: [
      { id: 'task-intake', title: 'Clarify task and constraints', status: 'pending', owner: 'Cursor-analytiker' },
      { id: 'delegate', title: 'Delegate build steps to Codex', status: 'pending', owner: 'Cursor-analytiker' }
    ],
    actions: [],
    diffs: [],
    artifacts: [],
    checks: [],
    notes: [],
    handoff: 'analyst',
    telemetry: { task }
  };
}

function mapHandoffToAgent(handoff) {
  switch (handoff) {
    case 'analyst':
      return 'analyst';
    case 'implementer':
      return 'implementer';
    case 'verifier':
      return 'verifier';
    default:
      return 'complete';
  }
}

export {
  agentEnvelopeSchema,
  normalizeAgentExchange,
  formatEnvelopeSummary,
  createInitialEnvelope,
  mapHandoffToAgent
};
