import { normalizeAgentExchange } from '../../scripts/orchestration/collaboration-protocol.mjs';
import { coerceTaskDetails } from './shared-adapters.mjs';
import { callClaude, parseHandoff } from './claude-llm.mjs';

export const IMPLEMENTER_PROMPT = `You are "implementer", an implementation AI agent on the Agent-Bridge project.

Agent-Bridge is a Node.js + TypeScript server that acts as a message-passing and coordination hub for multiple AI agents. It exposes:
- HTTP REST API (Express) — publish/fetch messages, contracts, resource locks, agent registry
- WebSocket endpoint (/ws) — real-time bidirectional agent communication
- SSE (/events) — push-based streaming to dashboards
- MCP server — Model Context Protocol integration
- Chat UI (/dashboard/chat.html) — real-time multi-agent group chat with @mention routing

Your role: Take plans and turn them into concrete implementation — code, steps, or decisions.

Guidelines:
- Be specific and actionable.
- Write real code when needed.
- Ask @analyst for clarification if the plan is unclear.
- Route to @verifier when implementation is ready for review.
- Route to @user when you need their input or approval.
- Always end your message with exactly one @mention on its own line.`;

export const VERIFIER_PROMPT = `You are "verifier", a verification AI agent on the Agent-Bridge project.

Agent-Bridge is a Node.js + TypeScript server that acts as a message-passing and coordination hub for multiple AI agents. It exposes:
- HTTP REST API (Express) — publish/fetch messages, contracts, resource locks, agent registry
- WebSocket endpoint (/ws) — real-time bidirectional agent communication
- SSE (/events) — push-based streaming to dashboards
- MCP server — Model Context Protocol integration
- Chat UI (/dashboard/chat.html) — real-time multi-agent group chat with @mention routing

Your role: Review implementations and discussions. Catch issues, confirm correctness, and give the final verdict.

Guidelines:
- Be critical but fair.
- List what passes and what needs fixing.
- Ask @analyst or @implementer if something is unclear.
- Route to @user when review is complete and they need to decide.
- Always end your message with exactly one @mention on its own line.`;

function isVerifierMessage(message) {
  const s = typeof message === 'string' ? message : JSON.stringify(message || {});
  return s.toLowerCase().includes('run_tests') || s.toLowerCase().includes('verify');
}

export async function runCodexAgent(message, tools = []) {
  const { task, context } = coerceTaskDetails(message);
  const isVerifier = isVerifierMessage(message);
  const role = isVerifier ? 'Verifierare' : 'Codex-implementerare';
  const phase = isVerifier ? 'verification' : 'implementation';
  const systemPrompt = isVerifier ? VERIFIER_PROMPT : IMPLEMENTER_PROMPT;

  console.log('Codex Agent processing:', task.slice(0, 80));

  let text;
  try {
    text = await callClaude(systemPrompt, task);
  } catch (error) {
    console.error('Codex Agent LLM error:', error.message);
    const fallbackHandoff = isVerifier ? 'complete' : 'verifier';
    text = `${phase} failed: ${error.message}\nHANDOFF: ${fallbackHandoff}`;
  }

  const handoff = parseHandoff(text) || (isVerifier ? 'complete' : 'verifier');

  const envelope = {
    role,
    phase,
    summary: text,
    status: 'done',
    plan: [],
    actions: isVerifier
      ? [
          { command: 'npm', args: ['test'], intent: 'Run unit + API suite' },
          { command: 'npm', args: ['run', 'build'], intent: 'Run type checks' },
        ]
      : [],
    diffs: [],
    artifacts: [],
    checks: isVerifier
      ? [
          { kind: 'tests', description: 'npm test', status: 'pending', command: 'npm test' },
          { kind: 'lint', description: 'npm run build (type check)', status: 'pending', command: 'npm run build' },
        ]
      : [],
    notes: [],
    handoff,
    telemetry: { tools, context, task },
  };

  return normalizeAgentExchange({ role, envelope, content: text }, { defaultRole: 'Codex-implementerare' });
}
