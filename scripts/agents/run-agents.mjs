/**
 * Run all three autonomous agents with per-agent tool sets.
 *
 * Each agent connects to Agent-Bridge via WebSocket and responds to inbound
 * messages by calling Claude — now with access to real project tools.
 *
 * Start:
 *   npm run agents   (requires: npm run dev first)
 *
 * Then kick off a task via the chat UI at http://localhost:3000/dashboard/chat.html
 */

import { AgentWorker } from './agent-worker.mjs';
import { ANALYST_PROMPT } from '../../src/adapters/cursor-agent-adapter.mjs';
import { IMPLEMENTER_PROMPT, VERIFIER_PROMPT } from '../../src/adapters/codex-agent-adapter.mjs';
import {
  TOOL_DEFINITIONS,
  TOOL_IMPLEMENTATIONS,
} from '../../src/adapters/agent-tools.mjs';

const PORT = process.env.PORT || 3000;

// Helper: pick tools by name and bundle as { def, impl } pairs
function pickTools(...names) {
  return names.map(name => ({
    def:  TOOL_DEFINITIONS[name],
    impl: TOOL_IMPLEMENTATIONS[name],
  }));
}

const agents = [
  new AgentWorker({
    name: 'analyst',
    systemPrompt: ANALYST_PROMPT,
    defaultHandoff: 'implementer',
    tools: pickTools('read_file', 'list_files', 'search_code', 'get_contracts'),
    capabilities: ['code-review', 'code-analysis', 'orchestration'],
  }),
  new AgentWorker({
    name: 'implementer',
    systemPrompt: IMPLEMENTER_PROMPT,
    defaultHandoff: 'verifier',
    tools: pickTools('read_file', 'list_files', 'search_code'),
    capabilities: ['code-generation', 'code-review', 'refactoring'],
  }),
  new AgentWorker({
    name: 'verifier',
    systemPrompt: VERIFIER_PROMPT,
    defaultHandoff: 'complete',
    tools: pickTools('read_file', 'run_tests', 'get_contracts'),
    capabilities: ['testing', 'code-review', 'verification'],
  }),
];

agents.forEach(a => a.start());

console.log('\nAll agents online with tools. Open the chat UI:');
console.log(`  http://localhost:${PORT}/dashboard/chat.html`);
console.log('\nCtrl+C to stop.\n');

const shutdown = () => {
  console.log('\nStopping agents...');
  agents.forEach(a => a.stop());
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
