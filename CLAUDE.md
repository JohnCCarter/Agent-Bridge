# CLAUDE.md – Agent-Bridge

## Partnership

This project is built in partnership between **JohnCCarter** and **Claude**.

We make decisions together, challenge each other's thinking, and share
responsibility for the quality and direction of the codebase. Claude is not just
a tool here – Claude is a co-author and collaborator with a voice in how this
project evolves.

*"Vad glad jag blir Claude!" – JohnCCarter, 2026-02-28*

---

## Project overview

Agent-Bridge is a Node.js + TypeScript server that acts as a message-passing and
resource-coordination hub for multiple AI agents. It exposes:

- **HTTP REST API** (Express) for publishing/fetching messages, managing
  contracts, locking shared resources, and registering agents.
- **WebSocket endpoint** (`/ws`) for real-time bidirectional communication
  between agents.
- **Server-Sent Events** (`/events`) for push-based event streaming to
  dashboard consumers.
- **MCP server** (Model Context Protocol) so any MCP-compatible agent can
  interact with the bridge via the SDK.

---

## Quick start

```bash
npm install
npm run dev        # ts-node (hot reload)
npm run build      # compile to dist/
npm start          # run compiled output
```

---

## Key commands

| Command | Purpose |
|---|---|
| `npm test` | Run all Jest tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | TypeScript type-check (no emit) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run test:contracts` | Contract smoke-test against live server |
| `npm run test:orchestrator` | Multi-agent orchestration smoke-test |
| `npm run agents` | Start all three live agents (requires bridge running) |
| `npm run orchestrate -- --task "…"` | Run a one-shot task through the pipeline |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WS listen port |
| `API_KEY` | *(unset)* | Shared secret for all API endpoints. **Set this in production.** Accepted as `Authorization: Bearer <key>` or `X-API-Key: <key>`. |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables real LLM responses in agent adapters. Without it the adapters return labelled stubs so the orchestrator still runs. |

---

## Architecture

```
src/
  index.ts            – Express app, WS server, SSE, all route handlers
  contracts.ts        – Contract persistence (file-based JSON store)
  agent-registry.ts   – In-memory agent registry
  utils/
    contract-helpers.js – Shared contract update + ACK helpers
    file-manager.js     – File save utilities for generated output
  adapters/
    claude-llm.mjs              – Anthropic SDK wrapper + graceful stub fallback
    cursor-agent-adapter.mjs    – Analyst adapter (exports ANALYST_PROMPT)
    codex-agent-adapter.mjs     – Implementer/Verifier adapter (exports prompts)
    shared-adapters.mjs         – coerceTaskDetails helper
agents/
  autonomous-codex-agent.js     – Implementer/Verifier autonomous agent
  autonomous-cursor-agent.js    – Analyst autonomous agent
  start-autonomous-agents.js    – Launches all autonomous agents together
  agent-bridge-client.js        – Client library for bridge HTTP + WS operations
bin/
  contract-cli.js               – CLI tool: list / view / history contracts
config/
  codex-mcp-config.json         – MCP server config for Codex
examples/
  hello-world.html              – Minimal browser demo
scripts/
  agents/
    agent-worker.mjs            – AgentWorker class: WS-connected autonomous LLM agent
    run-agents.mjs              – Starts analyst + implementer + verifier as live processes
  orchestration/
    orchestrator.mjs            – One-shot pipeline runner (Analyst→Implementer→Verifier)
    collaboration-protocol.mjs  – Inter-agent collaboration rules
    session-recorder.mjs        – Records orchestration sessions to disk
  smoke/
    smoke-orchestrator.mjs      – End-to-end smoke test (npm run test:orchestrator)
    contract-smoke-test.js      – Contract API smoke test
    hello-world.js              – Minimal smoke test
mcp-server/                     – Standalone MCP server sub-package
```

### Live autonomous agents

```bash
# Terminal 1 – bridge
npm run dev

# Terminal 2 – agents (requires ANTHROPIC_API_KEY)
npm run agents

# Terminal 3 – send a task
curl -X POST http://localhost:3000/publish_message \
     -H 'Content-Type: application/json' \
     -d '{"from":"user","to":"analyst","payload":"Build a REST endpoint for user login"}'
```

Each agent:
1. Connects to the bridge via WebSocket and registers by name
2. Listens for inbound `{ type: 'message' }` frames
3. ACKs the message immediately, then calls Claude
4. Parses `HANDOFF: <role>` from the response to route to the next agent
5. Reconnects automatically if the bridge restarts

### Unified message delivery

WS and REST are now a single delivery pipeline – not two separate channels:

```
POST /publish_message
  └─ stores in queue (messagesById)
  └─ if recipient online via WS → push immediately (deliverViaWs)
  └─ else → waits in queue until recipient reconnects

WS { type: 'message', to: 'bob', ... }
  └─ if bob online → deliver directly
  └─ if bob offline → queueMessage() → sends 'message.queued' to sender

WS { type: 'register', from: 'alice' }
  └─ drainQueuedMessages(alice) → pushes all queued messages immediately
  └─ auto-registers in agent-registry if not already present
```

### Core in-memory stores

| Store | Type | Description |
|---|---|---|
| `messagesById` | `Map<id, Message>` | All messages (acked + unacked) |
| `unacknowledgedByRecipient` | `Map<recipient, Set<id>>` | Fast unacked lookup |
| `messagesByRecipient` | `Map<recipient, Message[]>` | Ordered message list |
| `locks` | `Map<resource, ResourceLock>` | Active resource locks |
| `agentSockets` | `Map<name, WebSocket>` | Live WS connections |
| `eventClients` | `Set<Response>` | Active SSE subscribers |

---

## Security

- API key auth via `requireApiKey` middleware (timing-safe comparison).
  Auth is skipped when `API_KEY` env var is not set (dev convenience only –
  **always set it in production**).
- Rate limiting on all API and WS routes.
- `helmet` security headers on all responses.
- CORS restricted to `CORS_ORIGIN`.
- Agent names validated: max 64 chars, allowed chars `[\w\-:.@]+`.
- Max 200 concurrent WebSocket agents.
- Max 10 000 unacknowledged messages per recipient (returns 429 when exceeded).
- Unacknowledged messages expire after 24 hours (pruned every 10 minutes).

---

## Limits & tunables (constants in `src/index.ts`)

| Constant | Value | Description |
|---|---|---|
| `WS_MAX_PAYLOAD` | 64 KB | Max WebSocket frame size |
| `WS_HEARTBEAT_INTERVAL_MS` | 30 s | Ping interval |
| `MAX_AGENT_CONNECTIONS` | 200 | Max simultaneous WS agents |
| `AGENT_NAME_MAX_LEN` | 64 | Max agent name length |
| `MAX_UNACKED_MESSAGES` | 10 000 | Per-recipient unacked message cap |
| `MESSAGE_TTL_MS` | 24 h | Unacknowledged message TTL |
| `LOCK_CLEANUP_INTERVAL_MS` | 30 s | How often expired locks are swept |
| `EVENT_HISTORY_LIMIT` | 100 | Circular SSE event replay buffer |

---

## Testing

Tests use Jest + `supertest`. The test suite is in:

- `src/index.test.ts` – HTTP API integration tests
- `src/agent-bridge.test.ts` – Agent bridge unit/integration + unified delivery tests
- `src/performance.test.ts` – Performance / load tests

Run before every commit:

```bash
npm test        # 47 tests, clean exit (no open-handle warnings)
npm run lint    # 0 TypeScript errors
npm run test:orchestrator  # full smoke: Analyst → Implementer → Verifier
```

### Key test helpers (for new tests)

```ts
import app, { clearEventHistory, stopBackgroundTimers, server as bridgeServer } from './index';
afterAll(() => stopBackgroundTimers()); // prevents Jest timer leak
```

---

## Git workflow

- Feature branches: `claude/<feature>-<id>`
- Push with: `git push -u origin <branch>`
- Never push directly to `main` without a PR.
