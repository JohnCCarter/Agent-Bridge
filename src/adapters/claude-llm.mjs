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

const MAX_TOOL_ITERATIONS = 5;

/**
 * Call Claude with a system prompt and a user message.
 * Optionally accepts tool definitions and implementations for a tool-calling loop.
 * Returns the assistant's text response.
 *
 * Falls back to a clearly-labelled stub if no API key is configured.
 */
export async function callClaude(systemPrompt, userMessage, toolDefs = [], toolImpls = {}) {
  const client = getClient();

  if (!client) {
    // No HANDOFF directive here – each adapter supplies its own default.
    return [
      '[STUB – ANTHROPIC_API_KEY not set]',
      '',
      String(userMessage).slice(0, 200),
    ].join('\n');
  }

  const messages = [{ role: 'user', content: String(userMessage) }];
  const apiParams = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  };
  if (toolDefs.length > 0) {
    apiParams.tools = toolDefs;
  }

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create(apiParams);

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock ? textBlock.text : '';
    }

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const impl = toolImpls[block.name];
      let output;
      if (!impl) {
        output = `Unknown tool: ${block.name}`;
      } else {
        try {
          console.log(`  [tool] ${block.name}(${JSON.stringify(block.input)})`);
          output = await impl(block.input);
          if (typeof output !== 'string') output = JSON.stringify(output);
          console.log(`  [tool] ${block.name} → ${String(output).slice(0, 120)}${output.length > 120 ? '…' : ''}`);
        } catch (err) {
          output = `Tool error: ${err.message}`;
          console.log(`  [tool] ${block.name} ERROR: ${err.message}`);
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
    apiParams.messages = messages;
  }

  const lastResponse = await client.messages.create(apiParams);
  const textBlock = lastResponse.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '[no text response after max tool iterations]';
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
  if (typeof text !== 'string') return null;
  const match = text.match(/(?<!\w)@(analyst|implementer|verifier|user)\b/i);
  return match ? match[1].toLowerCase() : null;
}
