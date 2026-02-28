# Agent-Bridge - Claude Instructions

## Project Overview

Agent-Bridge is a minimal MCP (Model Context Protocol) bridge built with Node.js + TypeScript. It provides an HTTP interface for message passing between AI agents, manages task contracts, handles resource locks, and streams status updates via Server-Sent Events (SSE).

### Core Functionality
- **Message handling** - Publish, fetch, and acknowledge messages between agents
- **Task Contracts** - Create task contracts with status, history, metadata, and message linking
- **Resource locks** - Simple TTL-based locking of files/resources with renewal and unlocking
- **Event Stream** - SSE endpoint (`/events`) streaming contract, message, and lock events
- **Agent orchestration** - Coordinate Cursor (analyst) and Codex (implementer/verifier) agents
- **Dashboard** - Real-time web view of contracts, locks, messages, and events

## Common Commands

### Development
```bash
npm install              # Install dependencies
npm run dev             # Start dev server (port 3000)
npm run build           # Build TypeScript to dist/
npm start               # Run production build
```

### Testing
```bash
npm test                # Run Jest tests
npm run test:watch      # Run tests in watch mode
npm run test:contracts  # Run contract smoke test
npm run test:orchestrator  # Run orchestrator smoke test
npm run lint            # Type check with tsc
```

### Orchestration
```bash
npm run orchestrate -- --task "Your task description"
```

### Contract Management CLI
```bash
npm run contracts:list              # List all contracts
npm run contracts:view -- <id>      # View specific contract
npm run contracts:history -- <id>   # View contract history
```

## Architecture

### Project Structure
```
src/
  contracts.ts       # Contract models and in-memory store
  index.ts           # Express app with endpoints and event streams
  index.test.ts      # Jest test suite
  adapters/
    cursor-agent-adapter.mjs   # Cursor agent wrapper
    codex-agent-adapter.mjs    # Codex agent wrapper
scripts/
  orchestrator.mjs              # Main orchestration logic
  collaboration-protocol.mjs    # Shared envelope schema
  contract-smoke-test.js        # Integration test
  smoke-orchestrator.mjs        # Orchestrator test
dashboard/                       # Web dashboard static assets
agent-bridge-client.js          # Axios/SSE client for agents
autonomous-cursor-agent.js      # Cursor agent implementation
autonomous-codex-agent.js       # Codex agent implementation
data/
  contracts.json                # Persistent contract storage
  orchestration-history/        # Session transcripts
```

### Key Components

**Agent Roles:**
1. **Cursor (Analyst)** - Analyzes tasks and requirements, hands off to Codex with `HANDOFF_TO_CODEX`
2. **Codex (Implementer)** - Creates implementations, hands off to verifier with `RUN_TESTS`
3. **Verifier** - Tests and validates implementations, completes with `implementation verified successfully`

**Collaboration Protocol:**
- Shared envelope schema with `plan`, `actions`, `diffs`, `artifacts`, `checks`, and `handoff` fields
- Normalized adapters emit structured envelopes instead of free-form text
- Stateful orchestrator feeds previous envelope to next agent
- Session flight recorder persists every run as JSON transcript

**Security:**
- Command whitelist for safe execution: `npm test`, `npm run build`, `npm run lint`, `node <script>`, `git status`, `git diff`
- All other commands blocked with warning

## API Endpoints

### Messages
- `POST /publish_message` - Publish message with optional contract creation
- `GET /fetch_messages/:recipient` - Fetch messages for recipient
- `POST /ack_message` - Acknowledge received message

### Contracts
- `POST /contracts` - Create new contract
- `GET /contracts/:id` - Get contract by ID
- `PATCH /contracts/:id/status` - Update contract status

### Resource Locks
- `POST /lock_resource` - Acquire resource lock
- `POST /renew_lock` - Renew existing lock
- `DELETE /unlock_resource/:resource` - Release lock

### Event Stream
- `GET /events` - Server-Sent Events stream (history buffer of 100 events)

### Dashboard
- `/dashboard` - Web interface for real-time monitoring

## Event Types

- `contract.created` - New contract created
- `contract.updated` - Contract status changed
- `contract.message_linked` - Message linked to contract
- `message.published` - New message published
- `message.acknowledged` - Message acknowledged
- `lock.created` - Resource lock acquired
- `lock.renewed` - Lock renewed
- `lock.released` - Lock released
- `lock.expired` - Lock expired

## Development Guidelines

### Code Style
- TypeScript with strict type checking
- Zod schemas for validation (see `src/contracts.ts`)
- Express for HTTP endpoints
- In-memory storage with JSON persistence

### Testing
- Jest for unit and integration tests
- Supertest for HTTP endpoint testing
- Smoke tests for end-to-end scenarios
- All tests should pass before committing

### Contract Lifecycle
1. **proposed** - Initial state when created
2. **accepted** - Agent accepts the contract
3. **in_progress** - Work has started
4. **completed** - Work finished successfully
5. **failed** - Work failed or was rejected

### Persistence
- Contracts saved to `data/contracts.json`
- Orchestration sessions saved to `data/orchestration-history/<sessionId>.json`
- Data directory excluded from git

## Important Notes

- Server runs on port 3000 (override with `PORT` env var)
- Event stream buffers last 100 events for reconnecting clients
- Contracts and locks are persisted and loaded on server restart
- Orchestrator completes tasks within 8 turns for efficiency
- Dashboard requires dev server running to access static assets

## Roadmap Status

All phases completed:
- ✅ Phase 1-5: Core contract, lock, and event functionality
- ✅ Phase 6: CLI tools, persistence, and dashboard
- ✅ Phase 7: Integration test automation with smoke tests

## Common Tasks

**When adding new endpoints:**
1. Add route handler in `src/index.ts`
2. Update API documentation in README
3. Add tests in `src/index.test.ts`
4. Update TypeScript types if needed

**When modifying contract schema:**
1. Update types in `src/contracts.ts`
2. Update Zod schema
3. Run `npm run lint` to check types
4. Update tests and documentation

**When changing orchestration logic:**
1. Modify adapters in `src/adapters/`
2. Update `scripts/orchestrator.mjs`
3. Run `npm run test:orchestrator`
4. Check session transcripts in `data/orchestration-history/`

**When debugging agent interactions:**
1. Check `data/contracts.json` for contract state
2. Review orchestration transcripts in `data/orchestration-history/`
3. Monitor `/events` stream in dashboard or with curl
4. Use contract CLI to inspect specific contracts
