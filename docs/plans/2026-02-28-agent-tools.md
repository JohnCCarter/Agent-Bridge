# Agent Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give agents asymmetric file-system knowledge via 5 read-only tools + Claude native tool_use loop, enabling genuine AI-to-AI dialogue grounded in real project data.

**Architecture:** In-process JS tools (read_file, list_files, search_code, run_tests, get_contracts) in `src/adapters/agent-tools.mjs`. `callClaude()` rebuilt as an async tool-calling loop using Anthropic's `tool_use` content blocks. Each AgentWorker receives a per-agent tool set.

**Tech Stack:** Node.js 22, `@anthropic-ai/sdk` ^0.78.0 (already installed), Jest/supertest for TypeScript server tests, `.mjs` smoke scripts for adapter-level tests.

---

## Important notes before starting

- **Never work on `main` directly.** Create branch: `git checkout -b feat/agent-tools`
- The test suite is `npm test` — 47 tests must pass at every commit.
- Adapter files (`src/adapters/*.mjs`) are plain JavaScript ES modules — NOT TypeScript.
- Jest only covers `src/**/*.ts`. Adapter-level tests live as `scripts/test-*.mjs` smoke scripts.
- `PROJECT_ROOT` for path sanitization = `process.cwd()` when agents run (project root).
- The bridge must be running for `get_contracts` and the integration smoke test.
- `grep` is available on Windows via Git Bash / msys — but `ripgrep` (rg) may not be. Use Node.js `fs.readdir` + recursive grep instead of shelling out for `search_code`.

---

## Task 1: Add `GET /contracts` list endpoint to the bridge

The `get_contracts` tool needs an HTTP endpoint to fetch all contracts. This endpoint doesn't exist yet.

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

### Step 1: Add `listContracts()` export to `src/contracts.ts`

Open `src/contracts.ts`. After the `getContract` function (around line 256), add:

```typescript
export function listContracts(): TaskContract[] {
  return Array.from(contracts.values());
}
```

Also add `listContracts` to the import list in `src/index.ts` where the contracts functions are imported (around line 10-17).

### Step 2: Add the route to `src/index.ts`

Find the `GET /contracts/:id` route (around line 760). Just BEFORE it, add:

```typescript
app.get('/contracts', requireApiKey, (_req: Request, res: Response) => {
  const all = listContracts().map(serializeContract);
  res.json({ contracts: all });
});
```

### Step 3: Write the failing test in `src/index.test.ts`

Find the `describe("Contract Operations"` block. Add a new test at the end of that describe block:

```typescript
it('GET /contracts should return all contracts as array', async () => {
  // Create two contracts
  await request(app)
    .post('/contracts')
    .send({ title: 'Contract A', description: 'desc', assignedTo: 'analyst', status: 'pending', priority: 'medium' });
  await request(app)
    .post('/contracts')
    .send({ title: 'Contract B', description: 'desc', assignedTo: 'implementer', status: 'pending', priority: 'high' });

  const res = await request(app).get('/contracts');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('contracts');
  expect(Array.isArray(res.body.contracts)).toBe(true);
  expect(res.body.contracts.length).toBe(2);
  expect(res.body.contracts[0]).toHaveProperty('id');
  expect(res.body.contracts[0]).toHaveProperty('title');
});
```

### Step 4: Run the failing test

```bash
npm test -- --testNamePattern="GET /contracts should return all"
```

Expected: **FAIL** with "Cannot GET /contracts" or similar.

### Step 5: Implement and verify

The implementation is already done in Step 2. Run:

```bash
npm test
```

Expected: **all 48 tests pass** (47 + 1 new).

### Step 6: Commit

```bash
git add src/contracts.ts src/index.ts src/index.test.ts
git commit -m "feat: add GET /contracts list endpoint for agent tools"
```

---

## Task 2: Create `src/adapters/agent-tools.mjs` with 5 tool implementations

**Files:**
- Create: `src/adapters/agent-tools.mjs`

### Step 1: Create the file with path sanitization and all 5 tools

```javascript
/**
 * Agent Tools — read-only filesystem and bridge tools for AgentWorker instances.
 *
 * Security: all file paths are sanitized to prevent directory traversal.
 * Nothing writes, deletes, or executes arbitrary shell commands.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Project root = where the process was started from (i.e., the repo root)
const PROJECT_ROOT = path.resolve(process.cwd());
const MAX_FILE_BYTES = 50 * 1024; // 50 KB hard cap for read_file

/**
 * Resolve userPath relative to PROJECT_ROOT and verify it doesn't escape.
 * Throws if path traversal is attempted.
 */
function safePath(userPath) {
  if (path.isAbsolute(userPath)) {
    throw new Error(`Absolute paths not allowed: ${userPath}`);
  }
  const resolved = path.resolve(PROJECT_ROOT, userPath);
  // On Windows path.sep is '\\' but both separators are valid; normalise
  const rootWithSep = PROJECT_ROOT.endsWith(path.sep) ? PROJECT_ROOT : PROJECT_ROOT + path.sep;
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}

// ── Tool implementations ────────────────────────────────────────────────────

export async function read_file({ path: userPath }) {
  const safe = safePath(userPath);
  let buf;
  try {
    buf = await fs.readFile(safe);
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
  if (buf.length > MAX_FILE_BYTES) {
    return buf.slice(0, MAX_FILE_BYTES).toString('utf8') + '\n\n[truncated — file exceeds 50 KB]';
  }
  return buf.toString('utf8');
}

export async function list_files({ path: userPath = '.' }) {
  const safe = safePath(userPath);
  let entries;
  try {
    entries = await fs.readdir(safe, { withFileTypes: true });
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
  return entries
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n');
}

/**
 * Recursively search files for a pattern using Node.js (no shell dependency).
 * Returns matching lines in "file:line: content" format, up to 100 matches.
 */
export async function search_code({ pattern, path: userPath = '.' }) {
  const safe = safePath(userPath);
  const regex = new RegExp(pattern, 'i');
  const results = [];

  async function walk(dir) {
    if (results.length >= 100) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 100) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        await walk(full);
      } else if (/\.(ts|mjs|js|json|md)$/.test(entry.name)) {
        let content;
        try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        const rel = path.relative(PROJECT_ROOT, full);
        lines.forEach((line, i) => {
          if (results.length < 100 && regex.test(line)) {
            results.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }

  await walk(safe);
  return results.length > 0 ? results.join('\n') : '(no matches)';
}

export async function run_tests({ pattern = '' } = {}) {
  const args = ['test', '--forceExit', '--no-coverage'];
  if (pattern) args.push('--testNamePattern', pattern);
  try {
    const { stdout, stderr } = await execFileAsync('npm', args, {
      timeout: 90_000,
      cwd: PROJECT_ROOT,
      shell: true,       // needed on Windows for npm
    });
    return (stdout + stderr).slice(-8000); // last 8 KB (test summary is at the end)
  } catch (err) {
    // npm test exits non-zero when tests fail — still return the output
    return ((err.stdout || '') + (err.stderr || '')).slice(-8000);
  }
}

export async function get_contracts() {
  const PORT = process.env.PORT || 3000;
  const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
  try {
    const res = await fetch(`http://localhost:${PORT}/contracts`, { headers });
    if (!res.ok) return `Error fetching contracts: ${res.status} ${res.statusText}`;
    const data = await res.json();
    if (!data.contracts || data.contracts.length === 0) return '(no contracts)';
    return JSON.stringify(data.contracts, null, 2);
  } catch (err) {
    return `Error reaching bridge: ${err.message}`;
  }
}

// ── Tool registry for callClaude ────────────────────────────────────────────

/**
 * Map of tool name → implementation function.
 * callClaude uses this to dispatch tool_use requests from Claude.
 */
export const TOOL_IMPLEMENTATIONS = {
  read_file,
  list_files,
  search_code,
  run_tests,
  get_contracts,
};

/**
 * Anthropic tool definitions (schema) for each tool.
 * Pass a subset of TOOL_DEFINITIONS to callClaude() to enable specific tools.
 */
export const TOOL_DEFINITIONS = {
  read_file: {
    name: 'read_file',
    description: 'Read the contents of a file in the project. Use this to understand existing code, configuration, or documentation before planning or reviewing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root, e.g. "src/index.ts"' },
      },
      required: ['path'],
    },
  },

  list_files: {
    name: 'list_files',
    description: 'List files and directories at a given path. Use this to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to project root, e.g. "src/adapters"' },
      },
    },
  },

  search_code: {
    name: 'search_code',
    description: 'Search for a pattern (case-insensitive regex) across all .ts, .mjs, .js, .json, and .md files. Returns up to 100 matching lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for, e.g. "auth|jwt|bearer"' },
        path:    { type: 'string', description: 'Directory to search in (default: project root)' },
      },
      required: ['pattern'],
    },
  },

  run_tests: {
    name: 'run_tests',
    description: 'Run the Jest test suite (npm test) and return the output. Use this to verify that existing tests pass. Optionally filter by test name pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional Jest --testNamePattern filter' },
      },
    },
  },

  get_contracts: {
    name: 'get_contracts',
    description: 'Fetch all current task contracts from the Agent-Bridge server. Use this to understand what tasks are tracked and their status.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
};
```

### Step 2: Write a smoke test to verify the tools work

Create `scripts/test-agent-tools.mjs`:

```javascript
/**
 * Smoke test for agent-tools.mjs
 * Run: node scripts/test-agent-tools.mjs
 * (No bridge needed for read_file, list_files, search_code)
 */

import { read_file, list_files, search_code, run_tests } from '../src/adapters/agent-tools.mjs';

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
  const result = await search_code({ pattern: 'AgentWorker' });
  assert(result !== '(no matches)', 'expected at least one match for AgentWorker');
});

await test('search_code: returns (no matches) for nonsense', async () => {
  const result = await search_code({ pattern: 'ZZZNOMATCH999XYZ' });
  assert(result === '(no matches)', 'expected no matches');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

### Step 3: Run the smoke test

```bash
node scripts/test-agent-tools.mjs
```

Expected output:
```
─ agent-tools smoke test ─

  ✓ read_file: reads package.json
  ✓ read_file: rejects path traversal
  ✓ read_file: rejects absolute path
  ✓ list_files: lists src/
  ✓ list_files: appends / to directories
  ✓ search_code: finds pattern in code
  ✓ search_code: returns (no matches) for nonsense

7 passed, 0 failed
```

### Step 4: Run `npm test` to verify no regressions

```bash
npm test
```

Expected: **all 48 tests pass** (unchanged from Task 1).

### Step 5: Commit

```bash
git add src/adapters/agent-tools.mjs scripts/test-agent-tools.mjs
git commit -m "feat: add agent-tools.mjs with 5 read-only tools for agent access"
```

---

## Task 3: Rebuild `callClaude` into a tool-calling loop

**Files:**
- Modify: `src/adapters/claude-llm.mjs`

### Step 1: Read the current file

The current `callClaude(systemPrompt, userMessage)` makes a single API call and returns `response.content[0].text`.

### Step 2: Replace `callClaude` with a tool-calling loop

Replace the entire `callClaude` function (keep `parseHandoff` and `parseMention` unchanged):

```javascript
/**
 * Call Claude with a system prompt, a user message, and optional tools.
 *
 * If tools are provided, runs an async tool-calling loop:
 *   1. Send messages with tools to API
 *   2. If response has tool_use blocks: execute tools, append results, repeat
 *   3. Up to MAX_TOOL_ITERATIONS (5) iterations
 *   4. Return final text content
 *
 * Falls back to a clearly-labelled stub if no API key is configured.
 */

const MAX_TOOL_ITERATIONS = 5;

export async function callClaude(systemPrompt, userMessage, toolDefs = [], toolImpls = {}) {
  const client = getClient();

  if (!client) {
    return [
      '[STUB – ANTHROPIC_API_KEY not set]',
      '',
      String(userMessage).slice(0, 200),
    ].join('\n');
  }

  const messages = [{ role: 'user', content: String(userMessage) }];
  const apiParams = {
    model: MODEL,
    max_tokens: 4096,    // increased from 1024 to allow room for tool-heavy responses
    system: systemPrompt,
    messages,
  };
  if (toolDefs.length > 0) {
    apiParams.tools = toolDefs;
  }

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create(apiParams);

    // Collect all tool_use blocks
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // No tools needed (or end_turn): return the text
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock ? textBlock.text : '';
    }

    // Execute all tool_use blocks and collect results
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const impl = toolImpls[block.name];
      let output;
      if (!impl) {
        output = `Unknown tool: ${block.name}`;
      } else {
        try {
          output = await impl(block.input);
          if (typeof output !== 'string') output = JSON.stringify(output);
        } catch (err) {
          output = `Tool error: ${err.message}`;
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      });
    }

    // Append assistant turn (with tool_use blocks) + user turn (with tool_results)
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // Update apiParams messages for next iteration
    apiParams.messages = messages;
  }

  // Exhausted iterations — return whatever text we have from the last response
  const lastResponse = await client.messages.create(apiParams);
  const textBlock = lastResponse.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '[no text response after max tool iterations]';
}
```

**Key change:** Signature is now `callClaude(systemPrompt, userMessage, toolDefs=[], toolImpls={})`.

Existing callers that pass only `(systemPrompt, userMessage)` continue to work because `toolDefs=[]` means the API call has no tools parameter (single turn, same as before).

### Step 3: Run `npm test`

```bash
npm test
```

Expected: **all 48 tests pass**. The adapter calls in `cursor-agent-adapter.mjs` and `codex-agent-adapter.mjs` call `callClaude(systemPrompt, task)` — no tools, so they fall through the loop on first iteration.

### Step 4: Run the existing smoke test

```bash
node scripts/test-agent-tools.mjs
```

Expected: **7 passed, 0 failed** (unchanged — doesn't call callClaude directly).

### Step 5: Commit

```bash
git add src/adapters/claude-llm.mjs
git commit -m "feat: rebuild callClaude into async tool-calling loop (tool_use API)"
```

---

## Task 4: Update `AgentWorker` to pass tools to `callClaude`

**Files:**
- Modify: `scripts/agents/agent-worker.mjs`

### Step 1: Read the current file

`AgentWorker` takes `{ name, systemPrompt, defaultHandoff }` and calls `callClaude(contextualPrompt, content)`.

### Step 2: Add `tools` parameter to constructor and pass to callClaude

Diff of changes needed:

**Constructor:** add `tools = []` to destructured params and store as `#tools`.

**`#handle` method:** pass `this.#tools.defs` and `this.#tools.impls` to `callClaude`.

Full updated file (replace entirely):

```javascript
/**
 * AgentWorker – a long-running WebSocket agent that connects to Agent-Bridge,
 * listens for incoming messages, calls Claude with optional tools, and forwards
 * the response to the next agent based on the @mention in the reply.
 */

import WebSocket from 'ws';
import { callClaude, parseMention } from '../../src/adapters/claude-llm.mjs';

const PORT = process.env.PORT || 3000;
const BRIDGE_WS_URL = `ws://localhost:${PORT}/ws`;
const BRIDGE_HTTP = `http://localhost:${PORT}`;
const MAX_TURNS = 10;
const KNOWN_AGENTS = ['analyst', 'implementer', 'verifier', 'user'];

export class AgentWorker {
  #name;
  #systemPrompt;
  #defaultHandoff;
  #toolDefs;
  #toolImpls;
  #ws = null;
  #reconnectDelay = 1000;
  #stopped = false;
  #turnCount = 0;
  #processing = false;

  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.systemPrompt
   * @param {string} opts.defaultHandoff
   * @param {Array}  opts.tools  – array of { def, impl } pairs (optional)
   */
  constructor({ name, systemPrompt, defaultHandoff, tools = [] }) {
    this.#name = name;
    this.#systemPrompt = systemPrompt;
    this.#defaultHandoff = defaultHandoff;
    this.#toolDefs  = tools.map(t => t.def);
    this.#toolImpls = Object.fromEntries(tools.map(t => [t.def.name, t.impl]));
  }

  get name() { return this.#name; }

  start() {
    console.log(`[${this.#name}] Starting...`);
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  #connect() {
    if (this.#stopped) return;

    const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
    this.#ws = new WebSocket(BRIDGE_WS_URL, { headers });

    this.#ws.on('open', () => {
      console.log(`[${this.#name}] Connected to bridge`);
      this.#reconnectDelay = 1000;
      this.#turnCount = 0;
      this.#send({ type: 'register', from: this.#name });
    });

    this.#ws.on('message', async (raw) => {
      if (this.#processing) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.#processing = true;
      try { await this.#handle(msg); } finally { this.#processing = false; }
    });

    this.#ws.on('close', () => {
      if (this.#stopped) return;
      console.log(`[${this.#name}] Disconnected – reconnecting in ${this.#reconnectDelay}ms`);
      setTimeout(() => this.#connect(), this.#reconnectDelay);
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
    });

    this.#ws.on('error', (err) => {
      console.error(`[${this.#name}] WS error: ${err.message}`);
    });
  }

  async #handle(msg) {
    if (msg.type !== 'message') return;

    const { id, from = 'unknown', payload } = msg;
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');

    console.log(`[${this.#name}] ← ${from}: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`);

    if (id) this.#send({ type: 'ack', id });

    // Loop protection
    this.#turnCount++;
    if (this.#turnCount > MAX_TURNS) {
      console.log(`[${this.#name}] ⚠ Max turns reached – returning control to user`);
      this.#send({ type: 'message', from: this.#name, to: 'user', payload: '⚠ Max turns reached. Please review and continue.' });
      this.#turnCount = 0;
      return;
    }

    // Build context from conversation history
    const history = await this.#fetchHistory(20);
    const toolNote = this.#toolDefs.length > 0
      ? `\nYou have access to tools: ${this.#toolDefs.map(t => t.name).join(', ')}. Use them to read files and understand the project before responding.`
      : '';
    const contextualPrompt = history
      ? `${this.#systemPrompt}${toolNote}\n\n--- Conversation so far ---\n${history}\n--- End of conversation ---\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`
      : `${this.#systemPrompt}${toolNote}\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`;

    let response;
    try {
      response = await callClaude(contextualPrompt, content, this.#toolDefs, this.#toolImpls);
    } catch (err) {
      console.error(`[${this.#name}] LLM error: ${err.message}`);
      response = `Error processing message: ${err.message} @user`;
    }

    // Parse @mention for routing; fall back to user if none found or self-mention
    const rawMention = parseMention(response);
    const next = (rawMention && rawMention !== this.#name && KNOWN_AGENTS.includes(rawMention))
      ? rawMention
      : 'user';

    const preview = response.slice(0, 120) + (response.length > 120 ? '…' : '');

    if (next === 'user') {
      this.#turnCount = 0;
      console.log(`[${this.#name}] → user: ${preview}`);
    } else {
      console.log(`[${this.#name}] → ${next}: ${preview}`);
    }

    this.#send({ type: 'message', from: this.#name, to: next, payload: response });
  }

  #send(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
    }
  }

  async #fetchHistory(limit = 20) {
    try {
      const fetchHeaders = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
      const res = await fetch(`${BRIDGE_HTTP}/conversation?limit=${limit}`, { headers: fetchHeaders });
      if (!res.ok) return '';
      const data = await res.json();
      if (!Array.isArray(data.messages)) return '';
      return data.messages
        .map(m => `[${m.sender}] ${m.content}`)
        .join('\n');
    } catch {
      return '';
    }
  }
}
```

### Step 3: Run `npm test`

```bash
npm test
```

Expected: **all 48 tests pass** (AgentWorker is not tested by Jest directly — no test changes needed).

### Step 4: Commit

```bash
git add scripts/agents/agent-worker.mjs
git commit -m "feat: AgentWorker accepts tools array, passes defs+impls to callClaude"
```

---

## Task 5: Wire up per-agent tool sets in `run-agents.mjs`

**Files:**
- Modify: `scripts/agents/run-agents.mjs`

### Step 1: Read the current file

Currently creates 3 `AgentWorker` instances with no tools.

### Step 2: Replace the file to wire up tools

```javascript
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
  }),
  new AgentWorker({
    name: 'implementer',
    systemPrompt: IMPLEMENTER_PROMPT,
    defaultHandoff: 'verifier',
    tools: pickTools('read_file', 'list_files', 'search_code'),
  }),
  new AgentWorker({
    name: 'verifier',
    systemPrompt: VERIFIER_PROMPT,
    defaultHandoff: 'complete',
    tools: pickTools('read_file', 'run_tests', 'get_contracts'),
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
```

### Step 3: Run `npm test`

```bash
npm test
```

Expected: **all 48 tests pass**.

### Step 4: Commit

```bash
git add scripts/agents/run-agents.mjs
git commit -m "feat: wire up per-agent tool sets (analyst/implementer/verifier)"
```

---

## Task 6: Update agent system prompts to describe available tools

**Files:**
- Modify: `src/adapters/cursor-agent-adapter.mjs` (ANALYST_PROMPT)
- Modify: `src/adapters/codex-agent-adapter.mjs` (IMPLEMENTER_PROMPT, VERIFIER_PROMPT)

### Step 1: Update `ANALYST_PROMPT` in `cursor-agent-adapter.mjs`

Replace the `ANALYST_PROMPT` export with:

```javascript
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
```

### Step 2: Update `IMPLEMENTER_PROMPT` and `VERIFIER_PROMPT` in `codex-agent-adapter.mjs`

Replace both exports with:

```javascript
export const IMPLEMENTER_PROMPT = `You are "implementer", an implementation AI agent on the Agent-Bridge project.

Agent-Bridge is a Node.js + TypeScript server that acts as a message-passing and coordination hub for multiple AI agents. It exposes:
- HTTP REST API (Express) — publish/fetch messages, contracts, resource locks, agent registry
- WebSocket endpoint (/ws) — real-time bidirectional agent communication
- SSE (/events) — push-based streaming to dashboards
- MCP server — Model Context Protocol integration
- Chat UI (/dashboard/chat.html) — real-time multi-agent group chat with @mention routing

Your role: Take plans and turn them into concrete implementation — code, steps, or decisions. You have tools to read the actual codebase.

Tools available to you:
- read_file(path): Read existing code to understand patterns before suggesting changes
- list_files(path): Explore what files exist
- search_code(pattern, path?): Find where specific patterns are used

Guidelines:
- USE YOUR TOOLS before suggesting code. Read the file you're modifying. Look for existing patterns.
- Be specific and actionable. Write real code when needed.
- If you discover something unexpected (missing dep, wrong pattern), surface it to @analyst.
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

Your role: Review implementations. Catch issues. Confirm correctness. Give the final verdict. You have tools to run actual tests and read actual code.

Tools available to you:
- run_tests(pattern?): Run the Jest suite and see real results
- read_file(path): Read the implementation being reviewed
- get_contracts(): Check if the work aligns with existing contracts

Guidelines:
- RUN THE TESTS. Don't just read the code — execute run_tests() and report real results.
- Read the actual implementation files before commenting on them.
- Be critical but fair. List specifically what passes and what needs fixing, with file:line references.
- Route to @implementer if fixes are needed (be specific about what).
- Route to @analyst if the approach itself is wrong.
- Route to @user when review is complete and they need to decide — include test results.
- Always end your message with exactly one @mention on its own line.`;
```

### Step 3: Run `npm test`

```bash
npm test
```

Expected: **all 48 tests pass** (prompts are strings, no compile-time impact).

### Step 4: Commit

```bash
git add src/adapters/cursor-agent-adapter.mjs src/adapters/codex-agent-adapter.mjs
git commit -m "feat: update agent prompts to describe and encourage tool use"
```

---

## Task 7: End-to-end smoke test

Verify the full agent-tools pipeline works with live agents.

**Files:**
- No changes — this is a verification task.

### Step 1: Start the bridge

In terminal 1:
```bash
npm run dev
```
Expected: `Server listening on port 3000`

### Step 2: Start the agents

In terminal 2 (requires ANTHROPIC_API_KEY to be set):
```bash
npm run agents
```
Expected:
```
[analyst] Connected to bridge
[implementer] Connected to bridge
[verifier] Connected to bridge
All agents online with tools.
```

### Step 3: Open the chat UI

Navigate to `http://localhost:3000/dashboard/chat.html`

### Step 4: Send a task that requires file reading

Type in the chat:
```
Explain what routes the bridge exposes. Use your tools to read the actual code.
```

Expected: analyst calls `list_files("src")`, then `read_file("src/index.ts")`, then responds with specific route names it actually found — not generic descriptions.

### Step 5: Verify tool use appears in terminal output

In terminal 2 (agents), you should see Claude making tool calls:
```
[analyst] ← user: Explain what routes…
[analyst] → implementer: I read src/index.ts and found these routes: GET /messages, POST /publish_message…
```

### Step 6: Run the full test suite one final time

```bash
npm test
```

Expected: **all 48 tests pass**.

### Step 7: Create PR

```bash
git push -u origin feat/agent-tools
gh pr create --title "feat: agent tools — genuine AI-to-AI communication via file-system access" \
  --body "$(cat <<'EOF'
## Summary
- Adds 5 read-only tools (read_file, list_files, search_code, run_tests, get_contracts)
- Rebuilds callClaude into an async tool_use loop (max 5 iterations)
- AgentWorker accepts per-agent tool sets
- Per-agent tool assignment: analyst (read+list+search+contracts), implementer (read+list+search), verifier (read+tests+contracts)
- Updates all three agent system prompts to describe and encourage tool use
- Adds GET /contracts list endpoint to the bridge

## Test plan
- [ ] npm test passes (48 tests)
- [ ] node scripts/test-agent-tools.mjs passes (7 smoke tests)
- [ ] Live agents use tools and respond with file-grounded answers

🤖 Generated with Claude Code
EOF
)"
```

---

## Recap — Files changed

| File | Change |
|------|--------|
| `src/contracts.ts` | Add `listContracts()` |
| `src/index.ts` | Add `GET /contracts` route |
| `src/index.test.ts` | Add test for `GET /contracts` |
| `src/adapters/agent-tools.mjs` | **New** — 5 tools + TOOL_DEFINITIONS + TOOL_IMPLEMENTATIONS |
| `src/adapters/claude-llm.mjs` | Rebuild `callClaude` as tool-calling loop |
| `src/adapters/cursor-agent-adapter.mjs` | Update ANALYST_PROMPT |
| `src/adapters/codex-agent-adapter.mjs` | Update IMPLEMENTER_PROMPT, VERIFIER_PROMPT |
| `scripts/agents/agent-worker.mjs` | Accept `tools` param, pass to callClaude |
| `scripts/agents/run-agents.mjs` | Wire up per-agent tool sets |
| `scripts/test-agent-tools.mjs` | **New** — smoke tests for tools |
