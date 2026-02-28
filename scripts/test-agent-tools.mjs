/**
 * Smoke test for agent-tools.mjs
 * Run: node scripts/test-agent-tools.mjs
 * (No bridge needed for read_file, list_files, search_code)
 */

import { read_file, list_files, search_code } from '../src/adapters/agent-tools.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('\n─ agent-tools smoke test ─\n');

await test('read_file: reads package.json', async () => {
  const result = await read_file({ path: 'package.json' });
  assert(result.includes('agent-bridge'), 'expected agent-bridge in package.json');
});

await test('read_file: rejects path traversal', async () => {
  const result = await read_file({ path: '../../../etc/passwd' });
  assert(result.includes('Error'), 'expected error for path traversal');
});

await test('read_file: rejects absolute path', async () => {
  const result = await read_file({ path: 'C:/Windows/System32/cmd.exe' });
  assert(result.includes('Error'), 'expected error for absolute path');
});

await test('list_files: lists src/', async () => {
  const result = await list_files({ path: 'src' });
  assert(result.includes('index.ts'), 'expected index.ts in src/');
});

await test('list_files: appends / to directories', async () => {
  const result = await list_files({ path: 'src' });
  assert(result.includes('adapters/'), 'expected adapters/ with trailing slash');
});

await test('search_code: finds pattern in code', async () => {
  const result = await search_code({ pattern: 'AgentWorker', path: 'src' });
  assert(result !== '(no matches)', 'expected at least one match for AgentWorker');
});

await test('search_code: returns (no matches) for nonsense', async () => {
  const result = await search_code({ pattern: 'ZZZNOMATCH999XYZ', path: 'src' });
  assert(result === '(no matches)', 'expected no matches');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
