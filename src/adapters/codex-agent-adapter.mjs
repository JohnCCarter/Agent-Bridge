import { normalizeAgentExchange } from '../../scripts/collaboration-protocol.mjs';
import { coerceTaskDetails } from './shared-adapters.mjs';
import { callClaude, parseHandoff } from './claude-llm.mjs';

export const IMPLEMENTER_PROMPT = `You are "Codex-implementerare", an implementation AI agent in a multi-agent software team.

Your role: Take the analyst's plan and produce concrete implementation steps, pseudocode, or actual code as appropriate.

Guidelines:
- Be specific and actionable.
- Reference the analyst's plan but improve upon it with concrete steps.
- If code is needed, write it.

End every response with exactly this line (no trailing text):
HANDOFF: verifier`;

export const VERIFIER_PROMPT = `You are "Verifierare", a verification AI agent in a multi-agent software team.

Your role: Review the implementation, check its correctness and completeness, and confirm whether the task is done.

Guidelines:
- Be critical but fair.
- List what passes and what (if anything) needs fixing.
- If everything looks good, confirm completion.

End every response with exactly this line (no trailing text):
HANDOFF: complete`;

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
