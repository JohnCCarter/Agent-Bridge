/**
 * Run all three autonomous agents as a single process.
 *
 * Each agent connects to Agent-Bridge via WebSocket, registers itself,
 * and responds to every inbound message by calling Claude.
 *
 * Start:
 *   npm run agents              # requires the bridge to be running (npm run dev)
 *
 * Then send a task to kick off the pipeline:
 *   curl -X POST http://localhost:3000/publish_message \
 *        -H 'Content-Type: application/json' \
 *        -d '{"from":"user","to":"analyst","payload":"Your task here"}'
 *
 * Or, if API_KEY is set:
 *   curl -X POST http://localhost:3000/publish_message \
 *        -H 'Content-Type: application/json' \
 *        -H 'X-API-Key: <your-key>' \
 *        -d '{"from":"user","to":"analyst","payload":"Your task here"}'
 */

import { AgentWorker } from './agent-worker.mjs';
import { ANALYST_PROMPT } from '../src/adapters/cursor-agent-adapter.mjs';
import { IMPLEMENTER_PROMPT, VERIFIER_PROMPT } from '../src/adapters/codex-agent-adapter.mjs';

const PORT = process.env.PORT || 3000;

const agents = [
  new AgentWorker({
    name: 'analyst',
    systemPrompt: ANALYST_PROMPT,
    defaultHandoff: 'implementer',
  }),
  new AgentWorker({
    name: 'implementer',
    systemPrompt: IMPLEMENTER_PROMPT,
    defaultHandoff: 'verifier',
  }),
  new AgentWorker({
    name: 'verifier',
    systemPrompt: VERIFIER_PROMPT,
    defaultHandoff: 'complete',
  }),
];

agents.forEach(a => a.start());

console.log('\nAll agents online. Send a task to start the pipeline:');
console.log(`  curl -X POST http://localhost:${PORT}/publish_message \\`);
console.log(`       -H 'Content-Type: application/json' \\`);
console.log(`       -d '{"from":"user","to":"analyst","payload":"Your task here"}'`);
console.log('\nCtrl+C to stop.\n');

const shutdown = () => {
  console.log('\nStopping agents...');
  agents.forEach(a => a.stop());
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
