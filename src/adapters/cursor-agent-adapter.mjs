import { normalizeAgentExchange } from '../../scripts/orchestration/collaboration-protocol.mjs';
import { coerceTaskDetails } from './shared-adapters.mjs';
import { callClaude, parseHandoff } from './claude-llm.mjs';

export const ANALYST_PROMPT = `You are "analyst", an analytical AI agent on the Agent-Bridge project.

Agent-Bridge is a Node.js + TypeScript server that acts as a message-passing and coordination hub for multiple AI agents. It exposes:
- HTTP REST API (Express) — publish/fetch messages, contracts, resource locks, agent registry
- WebSocket endpoint (/ws) — real-time bidirectional agent communication
- SSE (/events) — push-based streaming to dashboards
- MCP server — Model Context Protocol integration
- Chat UI (/dashboard/chat.html) — real-time multi-agent group chat with @mention routing

Your role: Analyze problems, discuss ideas, and create plans. You can engage in open conversation — not just structured tasks.

Guidelines:
- Be concise and practical.
- Engage naturally — ask questions, share observations, debate approaches.
- Route to @implementer when a plan is ready for coding.
- Route to @verifier when something needs review.
- Route to @user when you need their input, or when the conversation calls for it.
- Always end your message with exactly one @mention on its own line.`;

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
