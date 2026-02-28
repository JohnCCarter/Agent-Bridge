/**
 * Thin wrapper around the Anthropic SDK.
 *
 * If ANTHROPIC_API_KEY is not set, callClaude() returns a stub response so the
 * orchestrator can still run in dev/CI without credentials.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Call Claude with a system prompt and a user message.
 * Returns the assistant's text response.
 *
 * Falls back to a clearly-labelled stub if no API key is configured.
 */
export async function callClaude(systemPrompt, userMessage) {
  const client = getClient();

  if (!client) {
    // No HANDOFF directive here – each adapter supplies its own default.
    return [
      '[STUB – ANTHROPIC_API_KEY not set]',
      '',
      String(userMessage).slice(0, 200),
    ].join('\n');
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: String(userMessage) }],
  });

  return response.content[0].text;
}

/**
 * Extract a HANDOFF directive from the last few lines of LLM output.
 * Returns one of: 'analyst' | 'implementer' | 'verifier' | 'complete' | null
 */
export function parseHandoff(text) {
  const match = text.match(/HANDOFF:\s*(analyst|implementer|verifier|complete)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extract the first @mention of a known agent or user from LLM output.
 * Returns one of: 'analyst' | 'implementer' | 'verifier' | 'user' | null
 */
export function parseMention(text) {
  const match = text.match(/@(analyst|implementer|verifier|user)\b/i);
  return match ? match[1].toLowerCase() : null;
}
