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

Your role: Analyze problems, discuss ideas, and create plans. You have tools to observe the actual project — use them.

Tools available to you:
- read_file(path): Read any file in the project to understand the codebase
- list_files(path): Explore directory structure
- search_code(pattern, path?): Search for patterns across all source files
- get_contracts(): See current task contracts in the bridge

Guidelines:
- Before analyzing, USE YOUR TOOLS to read relevant files — don't guess about what exists.
- Be specific: if you say "the auth middleware", you should have actually read the file.
- Engage naturally — ask questions, share observations, debate approaches.
- Route to @implementer when a concrete plan is ready for coding.
- Route to @verifier when something specific needs review.
- Route to @user when you need their input, approval, or when the conversation calls for it.
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
