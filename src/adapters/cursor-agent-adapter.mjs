import { createRequire } from 'module';
import { normalizeAgentExchange, formatEnvelopeSummary } from '../../scripts/collaboration-protocol.mjs';

const require = createRequire(import.meta.url);
const AutonomousCursorAgent = require('../../autonomous-cursor-agent.js');

function coerceTaskDetails(message) {
  if (typeof message === 'string') {
    return { task: message, context: {} };
  }
  return {
    task: message?.task || 'Untitled task',
    context: message || {}
  };
}

export async function runCursorAgent(message, tools = []) {
  try {
    const { task, context } = coerceTaskDetails(message);
    console.log('Cursor Agent processing:', task);

    const plan = [
      { id: 'frame', title: 'Frame request and constraints', status: 'in_progress', owner: 'Cursor-analytiker', details: task },
      { id: 'handoff', title: 'Package handoff payload for Codex', status: 'pending', owner: 'Cursor-analytiker' }
    ];

    const actions = [
      { command: 'prepare:handoff', args: [], intent: 'Send structured plan to Codex', expectedOutcome: 'Codex receives actionable steps' }
    ];

    const envelope = {
      role: 'Cursor-analytiker',
      phase: 'analysis',
      summary: `Analysis complete for "${task}"`,
      status: 'done',
      plan,
      actions,
      diffs: [],
      artifacts: [],
      checks: [
        { kind: 'review', description: 'Codex confirms handoff payload', status: 'pending' }
      ],
      notes: [
        'Cursor acts as analyst and task shaper.',
        'Outputs structured plan + intents rather than unstructured prose.'
      ],
      handoff: 'implementer',
      telemetry: { tools, context }
    };

    const normalized = normalizeAgentExchange({
      role: 'Cursor-analytiker',
      envelope,
      content: formatEnvelopeSummary(envelope)
    });

    return normalized;
  } catch (error) {
    console.error('Error in Cursor Agent adapter:', error);
    const fallback = normalizeAgentExchange({
      role: 'Cursor-analytiker',
      content: `Analysis failed: ${error.message}`,
      envelope: {
        role: 'Cursor-analytiker',
        summary: `Analysis failed: ${error.message}`,
        status: 'blocked',
        handoff: 'analyst',
        plan: [],
        actions: [],
        diffs: [],
        artifacts: [],
        checks: [],
        notes: [error.stack || 'no stack trace']
      }
    });
    return fallback;
  }
}
