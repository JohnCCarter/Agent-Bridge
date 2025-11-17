# Agent-Bridge

Agent-Bridge är en minimal MCP-brygga byggd med Node.js + TypeScript. Den tillhandahåller ett enkelt HTTP-gränssnitt för att skicka meddelanden mellan agenter, hantera uppdragskontrakt, serialisera resurslås och strömma statusuppdateringar via Server-Sent Events.

## Funktioner

- **Meddelandehantering** – Publicera, hämta och kvittera meddelanden mellan agenter.
- **Task Contracts** – Skapa uppdragskontrakt med status, historik, metadata och koppling till meddelanden.
- **Resurslås** – Enkel TTL-baserad låsning av filer/resurser med förnyelse och upplåsning.
- **Event Stream** – SSE-endpoint (`/events`) som strömmar kontrakts-, meddelande- och låshändelser till lyssnande agenter.
- **Klienthjälpare** – `agent-bridge-client.js` erbjuder axios-wrapper, kontrakts-API, låshantering och eventprenumeration.

## Snabbstart

```bash
npm install
npm run dev
```

Servern startar på port `3000` (override med `PORT`).

### Produktion

```bash
npm run build
npm start
```

### Tester

```bash
npm test
# eller kontinuerligt
npm run test:watch
```

### Kontrakts-smoke test

```bash
npm run test:contracts
```

Skriptet `scripts/contract-smoke-test.js` startar agent-bryggan på en tillfällig port, låter Cursor- och Codex-agenterna driva ett kodgenereringsscenario och kontrollerar att filer skrivs till `site/`, att kontraktets metadata innehåller `persistedPaths` och att loggarna visar sparade artefakter. Efter körning återställs `data/contracts.json` så att miljön förblir oförändrad.

## API-översikt

### Meddelanden

- `POST /publish_message`
- `GET /fetch_messages/:recipient`
- `POST /ack_message`

### Kontrakt

- `POST /contracts`
- `GET /contracts/:id`
- `PATCH /contracts/:id/status`

### Resurslås

- `POST /lock_resource`
- `POST /renew_lock`
- `DELETE /unlock_resource/:resource`

### Event Stream

- `GET /events` (Server-Sent Events)

## Exempel

### Skapa och koppla kontrakt via meddelande

```json
POST /publish_message
{
  "recipient": "codex-agent",
  "sender": "cursor-agent",
  "content": "{...}",
  "contract": {
    "title": "Analyse TypeScript config",
    "initiator": "cursor-agent",
    "owner": "codex-agent",
    "priority": "high",
    "tags": ["analysis", "typescript"],
    "files": ["tsconfig.json"]
  }
}
```

Svaren innehåller `messageId`, `contractId` och serialiserat kontrakt.

### Uppdatera kontrakt

```json
PATCH /contracts/:id/status
{
  "actor": "codex-agent",
  "status": "in_progress",
  "owner": "codex-agent",
  "note": "Work started"
}
```

### Event Stream (`/events`)

Svarshuvuden:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Varje event ser ut så här:

```
event: contract.updated
id: l7a3gxx49vul2t6m51

data: {
  "id": "l7a3gxx49vul2t6m51",
  "type": "contract.updated",
  "timestamp": "2025-09-25T12:45:09.123Z",
  "data": {
    "contract": { ... serialiserad contract ... },
    "actor": "codex-agent",
    "note": "Work started"
  }
}
```

Historikbufferten sparar de 100 senaste händelserna – nya klienter får historiken direkt efter anslutning. Följande händelsetyper skickas i dagsläget:

| Typ                       | Innehåll                                         |
| ------------------------- | ------------------------------------------------ |
| `contract.created`        | Serialiserat kontrakt (`contract`)               |
| `contract.updated`        | Serialiserat kontrakt + `actor`, `note`          |
| `contract.message_linked` | `contractId`, `messageId`                        |
| `message.published`       | `messageId`, `recipient`, `sender`, `contractId` |
| `message.acknowledged`    | `messageId`, `recipient`                         |
| `lock.created`            | `resource`, `holder`, `ttl`, `expiresAt`         |
| `lock.renewed`            | `resource`, `holder`, `ttl`, `expiresAt`         |
| `lock.released`           | `resource`, `holder`                             |
| `lock.expired`            | `resource`, `holder`                             |

### TaskContract (serialiserad)

```json
{
  "id": "c5z7k2u4...",
  "title": "Analyse TypeScript config",
  "initiator": "cursor-agent",
  "owner": "codex-agent",
  "status": "in_progress",
  "priority": "high",
  "tags": ["analysis", "typescript"],
  "files": ["tsconfig.json"],
  "createdAt": "2025-09-25T12:30:01.000Z",
  "updatedAt": "2025-09-25T12:45:09.000Z",
  "metadata": {
    "intent": "code_analysis",
    "correlationId": "cursor-..."
  },
  "history": [
    {
      "id": "h1...",
      "timestamp": "2025-09-25T12:30:01.000Z",
      "actor": "cursor-agent",
      "status": "proposed",
      "note": "Contract created"
    },
    {
      "id": "h2...",
      "timestamp": "2025-09-25T12:45:09.000Z",
      "actor": "codex-agent",
      "status": "in_progress",
      "note": "Work started"
    }
  ]
}
```

## Projektstruktur

```
src/
  contracts.ts       # Kontraktsmodeller och in-memory store
  index.ts           # Express-app med endpoints och eventströmmar
  index.test.ts      # Supertest/Jest-testfall
agent-bridge-client.js  # Axios/SSE-klient för agenter
autonomous-cursor-agent.js  # Cursor-agent med kontrakt & eventlyssning
autonomous-codex-agent.js   # Codex-agent med låshantering
start-autonomous-agents.js  # Bootskript för båda agenterna
```

## Licens

MIT

## Node Orchestrator (Path 2)

Agent-Bridge implements a Node.js-based orchestrator that coordinates agent interactions using adapter modules instead of child processes. This provides better integration and control over the agent workflow.

### Codex ↔ Cursor Collaboration Protocol

The orchestrator now drives a deterministic handoff protocol so Codex (implementer/verifier) and Cursor (analyst) can collaborate with structured state rather than free-form text:

- **Shared envelope schema** (`scripts/collaboration-protocol.mjs`) – Defines normalized agent responses with `plan`, `actions`, `diffs`, `artifacts`, `checks`, and a `handoff` target (`analyst | implementer | verifier | complete`).
- **Normalized adapters** – `src/adapters/cursor-agent-adapter.mjs` and `src/adapters/codex-agent-adapter.mjs` emit envelopes instead of ad-hoc prose, keeping plans and commands deterministic for Cursor ↔ Codex loops.
- **Stateful orchestrator** – `scripts/orchestrator.mjs` feeds each agent with the previous envelope, interprets the `handoff` field to select the next role, and logs the structured envelope in conversation history for repeatability.
- **Deterministic verification** – The verifier step explicitly requests `npm test` and `npm run build` via the whitelist-aware runner, making the collaboration loop testable end-to-end.
- **Executable checks** – Verification envelopes trigger whitelisted commands automatically (e.g., `npm run lint`, `npm test`), updating envelope status and redirecting the handoff if checks fail.
- **Session flight recorder** – Every orchestration run is persisted as a JSON transcript under `data/orchestration-history/`, capturing envelopes, executed checks, outcomes, and the final handoff so a session can be replayed, audited, or resumed with full context.

The result is a repeatable loop: Cursor analyzes and shapes the task → Codex implements with concrete diffs/actions → Codex verifier runs commands and completes the task when checks pass.

### Architecture

The orchestrator uses **adapter modules** for programmatic agent integration:

- `src/adapters/cursor-agent-adapter.mjs` - Wraps Cursor agent functionality
- `src/adapters/codex-agent-adapter.mjs` - Wraps Codex agent functionality  
- `scripts/orchestrator.mjs` - Main orchestration logic with handoff markers

### Agent Roles and Handoff Flow

1. **Cursor-analytiker** (Analyst) - Analyzes tasks and requirements
   - Handoff marker: `HANDOFF_TO_CODEX` → transitions to Implementer

2. **Codex-implementerare** (Implementer) - Creates implementations
   - Handoff marker: `RUN_TESTS` → transitions to Verifier

3. **Verifierare** (Verifier) - Tests and validates implementations  
   - Completion marker: `implementation verified successfully` → completes task

### Command Whitelist Security

The orchestrator includes a security whitelist for command execution (`run_cmd`):

**Allowed commands:**
- `npm test` (with optional flags like `npm test -s`)
- `npm run build`
- `npm run lint`
- `node <script.js>` (local script files only)
- `git status`
- `git diff`

**Blocked commands:** All others are blocked with a clear warning message.

**Extending the whitelist:** TODO - Configuration-driven expansion planned.

### Usage Examples

```bash
# Run orchestrator with a task
npm run orchestrate -- --task "Hello world"

# Run orchestrator smoke test
npm run test:orchestrator
```

### Example Workflow

```bash
$ npm run orchestrate -- --task "Create a calculator"

=== Node Orchestrator Starting ===
Task: "Create a calculator"

--- Turn 1 (analyst) ---
Cursor-analytiker: Analysis complete...
Next step: HANDOFF_TO_CODEX for implementation

--- Turn 2 (implementer) ---  
Codex-implementerare: Implementation complete...
Next step: RUN_TESTS for verification

--- Turn 3 (verifier) ---
Verifierare: Verification complete...
Status: Implementation verified successfully

=== Task completed successfully ===
```

### Session Recording Artifacts

Every orchestration run saves a JSON transcript to `data/orchestration-history/<sessionId>.json` containing:

- **meta** – Task description, session timestamps, final envelope, and success flag.
- **history** – Turn-by-turn envelopes, check executions, and responses (including the bootstrap state in turn `0`).

These artifacts are ignored by git and can be reused for replay, audits, or seeding the next collaboration loop with deterministic context.

The orchestrator automatically manages the agent handoffs and ensures tasks complete within 8 turns for efficient processing.

## Kontrakts-CLI

Ett enkelt verktyg följer med för att läsa den beständiga kontraktsloggen i `data/contracts.json`.

```bash
# lista alla kontrakt	npm run contracts:list

# visa ett enskilt kontrakt
npm run contracts:view -- <contractId>

# visa historik för ett kontrakt
npm run contracts:history -- <contractId>
```

Kontrakt lagras automatiskt på disk och laddas vid serverstart, vilket gör att omstarter inte rensar historik.

### Autonoma uppföljningar

När Codex upptäcker kritiska säkerhetsproblem eller tydliga rekommendationer skapar den automatiskt nya kontrakt åt Cursor. Dessa kontrakt syns direkt via CLI:t och i `/events`-strömmen.

### Dashboard

Door `/dashboard` exposes a lightweight real-time view of contracts, locks, messages, and raw events streamed from `/events`. The static assets live in `dashboard/` and can be served by running the development server and visiting the path in the browser.


