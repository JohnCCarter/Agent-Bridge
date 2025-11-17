import { createRequire } from 'module';
import { normalizeAgentExchange, formatEnvelopeSummary } from '../../scripts/collaboration-protocol.mjs';

const require = createRequire(import.meta.url);
const AutonomousCodexAgent = require('../../autonomous-codex-agent.js');

function coerceTaskDetails(message) {
  if (typeof message === 'string') {
    return { task: message, context: {} };
  }
  return { task: message?.task || 'Untitled task', context: message || {} };
}

function determineRole(message) {
  const normalizedMessage = typeof message === 'string' ? message : JSON.stringify(message || {});
  const lowerMessage = normalizedMessage.toLowerCase();
  if (lowerMessage.includes('run_tests') || lowerMessage.includes('verify')) {
    return 'Verifierare';
  }
  return 'Codex-implementerare';
}

function buildImplementerEnvelope(task, context, tools) {
  const diffs = [
    { path: 'docs/architecture.md', description: 'Describe Codex ↔ Cursor loop with protocol + states' },
    { path: 'scripts/collaboration-protocol.mjs', description: 'Shared schema for envelopes and handoffs' }
  ];

  const plan = [
    { id: 'wire-protocol', title: 'Align responses to collaboration protocol', status: 'in_progress', owner: 'Codex-implementerare' },
    { id: 'delegate-tests', title: 'Handoff to verifier for checks', status: 'pending', owner: 'Codex-implementerare' }
  ];

  const actions = [
    { command: 'apply:diffs', args: ['protocol', 'docs'], intent: 'land structured collaboration artifacts' },
    { command: 'npm', args: ['test'], intent: 'queue verification run', expectedOutcome: 'All orchestrator + API tests pass' }
  ];

  const checks = [
    { kind: 'tests', description: 'npm test', status: 'pending', command: 'npm test' },
    { kind: 'lint', description: 'tsc type check (build)', status: 'pending', command: 'npm run build' }
  ];

  return {
    role: 'Codex-implementerare',
    phase: 'implementation',
    summary: `Implementation plan for "${task}" ready for verification`,
    status: 'done',
    plan,
    actions,
    diffs,
    artifacts: [],
    checks,
    notes: ['Prepared runnable artifacts and commands for verifier.'],
    handoff: 'verifier',
    telemetry: { tools, context }
  };
}

function buildVerifierEnvelope(task, context, tools) {
  const checks = [
    { kind: 'tests', description: 'npm test', status: 'running', command: 'npm test' },
    { kind: 'lint', description: 'npm run build (type check)', status: 'pending', command: 'npm run build' }
  ];

  return {
    role: 'Verifierare',
    phase: 'verification',
    summary: `Verification queue for "${task}"`,
    status: 'done',
    plan: [
      { id: 'tests', title: 'Execute orchestrator + API tests', status: 'in_progress', owner: 'Verifierare' },
      { id: 'report', title: 'Report pass/fail and unblock next loop', status: 'pending', owner: 'Verifierare' }
    ],
    actions: [
      { command: 'npm', args: ['test'], intent: 'Run unit + API suite' },
      { command: 'npm', args: ['run', 'build'], intent: 'Run type checks' }
    ],
    diffs: [],
    artifacts: [],
    checks,
    notes: ['Verifier uses command whitelist to stay deterministic.'],
    handoff: 'complete',
    telemetry: { tools, context }
  };
}

export async function runCodexAgent(message, tools = []) {
  try {
    const { task, context } = coerceTaskDetails(message);
    console.log('Codex Agent processing:', task);

    const role = determineRole(message);
    const envelope = role === 'Verifierare'
      ? buildVerifierEnvelope(task, context, tools)
      : buildImplementerEnvelope(task, context, tools);

    const normalized = normalizeAgentExchange({
      role,
      envelope,
      content: formatEnvelopeSummary(envelope)
    }, { defaultRole: 'Codex-implementerare' });

    return normalized;
  } catch (error) {
    console.error('Error in Codex Agent adapter:', error);
    return normalizeAgentExchange({
      role: 'Codex-implementerare',
      content: `Implementation failed: ${error.message}`,
      envelope: {
        role: 'Codex-implementerare',
        summary: `Implementation failed: ${error.message}`,
        status: 'blocked',
        handoff: 'analyst',
        plan: [],
        actions: [],
        diffs: [],
        artifacts: [],
        checks: [],
        notes: [error.stack || 'no stack trace']
      }
    }, { defaultRole: 'Codex-implementerare' });
  }
}
