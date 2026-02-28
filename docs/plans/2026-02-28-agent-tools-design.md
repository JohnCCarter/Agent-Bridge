# Agent Tools — Genuine AI-to-AI Communication Design

**Date:** 2026-02-28
**Status:** Approved
**Partners:** JohnCCarter + Claude

---

## Goal

Give the three agents (analyst, implementer, verifier) genuinely asymmetric knowledge
via a small set of read-only tools, so they have real reasons to ask each other questions —
not just pass a task baton.

Agents should be able to *observe* the project (read files, search code, run tests,
see contracts) and base their questions and answers on what they actually see, not
assumptions.

---

## Approved Decisions

| Question | Decision |
|----------|----------|
| Tool mechanism | In-process JS functions + Claude native tool_use API |
| Tool count (MVP) | 5 tools |
| Scope | Read-only only — no write, no arbitrary shell |
| Architecture | Approach A: in-process, no extra servers |
| Tool assignment | Per-agent sets (analyst ≠ implementer ≠ verifier) |

---

## The 5 Tools

| Tool | Args | Description | Agents |
|------|------|-------------|--------|
| `read_file` | `path` (relative to project root) | Read file contents (max 50 KB, truncated with warning) | analyst, implementer, verifier |
| `list_files` | `path` | List files/dirs in a directory | analyst, implementer |
| `search_code` | `pattern`, `path?` | Grep-like code search | analyst, implementer |
| `run_tests` | `pattern?` (Jest filter) | Run `npm test` and return stdout/stderr | verifier |
| `get_contracts` | — | Fetch current contracts from bridge `/contracts` | analyst, verifier |

---

## Architecture

### In-process tool-calling loop

`callClaude()` is rebuilt into an async loop using Anthropic's `tool_use` content blocks:

```
callClaude(systemPrompt, task, tools=[])
  1. Build messages array
  2. POST to Anthropic API with tools parameter
  3. If response contains tool_use blocks:
       a. Execute each tool
       b. Append tool_result to messages
       c. POST to Anthropic API again
  4. Repeat max 5 iterations (prevents runaway loops)
  5. Return final text content block
```

### Per-agent tool sets

Configured in `scripts/run-agents.mjs` when instantiating `AgentWorker`:

```js
analyst:     ['read_file', 'list_files', 'search_code', 'get_contracts']
implementer: ['read_file', 'list_files', 'search_code']
verifier:    ['read_file', 'run_tests',  'get_contracts']
```

---

## Conversation Flow — What Changes

Before tools, agents only saw conversation history. Now they can observe the project:

```
User → analyst: "Build a login endpoint"

analyst:
  → list_files("src/")          → ["index.ts", "contracts.ts", …]
  → read_file("src/index.ts")   → [Express routes, no auth middleware]
  → get_contracts()             → []
  → "No auth middleware yet. No contracts. JWT is right for stateless.
     @implementer what token format — access+refresh or single token?"

implementer:
  → search_code("auth|jwt|bearer", "src/")  → (no matches)
  → read_file("package.json")               → (no jwt library)
  → "jsonwebtoken not in deps.
     @analyst should I add it or use something built-in?"

analyst:
  → "Add jsonwebtoken — standard choice here. @implementer go ahead."

implementer: [suggests implementation] → @verifier review

verifier:
  → run_tests()                 → [test output]
  → read_file("src/index.ts")   → [checks implementation]
  → "Tests pass. Token expiry is hardcoded though.
     @user — accept or parameterise?"
```

Every question is grounded in real data the agent discovered.

---

## Security

All implemented in `src/adapters/agent-tools.mjs`:

- **Path sanitization:** `path.resolve(projectRoot, requestedPath)` — verified to start with `projectRoot` before any file operation. Rejects `../` traversal and absolute paths.
- **Max read size:** `read_file` truncates at 50 KB with a `[truncated]` warning.
- **run_tests isolation:** Spawns `npm test` as a child process with a 60 s timeout. No other commands accepted. Returns stdout/stderr only.
- **get_contracts:** HTTP call to `http://localhost:${PORT}/contracts` — reads bridge state, no file access.

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `src/adapters/agent-tools.mjs` | **Create** — 5 tool implementations with path sanitization |
| `src/adapters/claude-llm.mjs` | **Modify** — rebuild `callClaude` into tool-calling loop |
| `scripts/agents/agent-worker.mjs` | **Modify** — accept `tools` param, pass to `callClaude` |
| `scripts/run-agents.mjs` | **Modify** — configure per-agent tool sets |
| `src/adapters/cursor-agent-adapter.mjs` | **Modify** — ANALYST_PROMPT: describe tools, when to use them |
| `src/adapters/codex-agent-adapter.mjs` | **Modify** — IMPLEMENTER_PROMPT, VERIFIER_PROMPT: describe tools |
| `src/agent-tools.test.ts` | **Create** — unit tests for all 5 tools + tool-calling loop |

---

## Testing

- **Unit tests per tool:** path traversal attacks, empty results, error handling, max-size truncation
- **Tool-loop unit test:** mock Anthropic client → verify `tool_use → tool_result → text` cycle
- **Integration test:** start bridge + agents, send task, verify tool calls appear in `/conversation` history
- **Existing tests must stay green:** `npm test` (47 tests) must pass after each task

---

## Out of Scope

- Write tools (write_file, delete_file, etc.)
- Arbitrary shell execution
- Persistent agent memory
- Agent-to-agent direct messaging (bypassing bridge)
- Parallel tool execution (tools run sequentially per response)
