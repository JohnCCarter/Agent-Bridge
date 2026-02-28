import { normalizeAgentExchange } from '../../scripts/collaboration-protocol.mjs';
import { coerceTaskDetails } from './shared-adapters.mjs';
import { callClaude, parseHandoff } from './claude-llm.mjs';

export const ANALYST_PROMPT = `You are "Cursor-analytiker", an analytical AI agent in a multi-agent software team.

Your role: Receive a task, think it through, and produce a clear analysis with an actionable plan.

Guidelines:
- Be concise and practical – no fluff.
- Focus on what needs to be done, not how long it takes.
- If the task is ambiguous, state your assumptions briefly.

End every response with exactly this line (no trailing text):
HANDOFF: implementer`;

export async function runCursorAgent(message, tools = []) {
  const { task, context } = coerceTaskDetails(message);
  console.log('Cursor Agent processing:', task);

  let text;
  try {
    text = await callClaude(ANALYST_PROMPT, task);
  } catch (error) {
    console.error('Cursor Agent LLM error:', error.message);
    text = `Analysis failed: ${error.message}\nHANDOFF: implementer`;
  }

  const handoff = parseHandoff(text) || 'implementer';

  const envelope = {
    role: 'Cursor-analytiker',
    phase: 'analysis',
    summary: text,
    status: 'done',
    plan: [],
    actions: [],
    diffs: [],
    artifacts: [],
    checks: [],
    notes: [],
    handoff,
    telemetry: { tools, context, task },
  };

  return normalizeAgentExchange({ role: 'Cursor-analytiker', envelope, content: text });
}
