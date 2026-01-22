# Copilot Instructions för Agent-Bridge

## Projektöversikt

Agent-Bridge är en minimal MCP-brygga byggd med Node.js + TypeScript som tillhandahåller ett HTTP-gränssnitt för att:
- Hantera meddelanden mellan agenter (publicera, hämta, kvittera)
- Skapa och hantera task contracts med status, historik och metadata
- Hantera resurslås med TTL-baserad låsning
- Strömma events via Server-Sent Events (SSE)
- Orkestrering av Codex- och Cursor-agenter med strukturerade handoff-protokoll

## Teknikstack

- **Backend**: Node.js med TypeScript och Express
- **Klient**: Axios för HTTP och EventSource för SSE
- **Testing**: Jest med Supertest
- **Databas**: SQLite (i mcp-server-modulen)
- **MCP Server**: TypeScript-baserad MCP-implementation med RBAC och säkerhetskontroller

## Kodstilar och konventioner

### TypeScript/JavaScript
- Använd **TypeScript** för all ny kod i `src/`-katalogen
- Använd **ES modules** (`.mjs`) för scripts och adapters
- Följ ESLint-konfigurationen i `.eslintrc.cjs`
- Använd beskrivande variabelnamn på svenska eller engelska beroende på kontext
- Föredra `const` framför `let`, undvik `var`

### Filstruktur
```
src/
  contracts.ts       # Kontraktsmodeller och in-memory store
  index.ts          # Express-app med endpoints
  index.test.ts     # Jest-testfall
  adapters/         # Agent-adapters för orkestrering
scripts/           # Verktygs- och orkestreringsskript
mcp-server/        # MCP-server implementation
dashboard/         # Frontend för real-time dashboard
```

### API-design
- Använd RESTful endpoints med tydliga verb (`POST`, `GET`, `PATCH`, `DELETE`)
- Returnera alltid strukturerad JSON med konsekvent schema
- Inkludera timestamps i ISO 8601-format
- Hantera fel med lämpliga HTTP-statuskoder

### Event-driven arkitektur
- Event types följer mönstret `<resource>.<action>` (t.ex. `contract.created`, `message.published`)
- Alla events innehåller `id`, `type`, `timestamp`, och `data`
- Buffert sparar de 100 senaste händelserna för nya klienter
- SSE-endpoints använder `Content-Type: text/event-stream`

## Testning

### Testkonventioner
- Alla nya funktioner ska ha motsvarande tester i `.test.ts`-filer
- Använd Supertest för API-tester
- Kör `npm test` innan commit
- Kör `npm run test:watch` under utveckling
- Smoke tests för kontrakt: `npm run test:contracts`
- Orchestrator tests: `npm run test:orchestrator`

### Test-driven utveckling
När du lägger till nya endpoints eller funktioner:
1. Skriv test först som beskriver förväntat beteende
2. Implementera funktionalitet
3. Kontrollera att alla tester går igenom
4. Refaktorera vid behov

## Säkerhet

### MCP Server säkerhet
- **RBAC**: Alla verktyg kontrolleras mot roller (`readonly`, `developer`, `admin`)
- **Whitelist**: Alla filsystem-paths valideras mot `allowedPaths` i config
- **Command safelist**: Endast godkända kommandon tillåts i `command_exec`
- **Rate limiting**: Token bucket per verktyg
- **Input validation**: Alla inputs valideras med Zod-scheman
- **Resource locking**: Mutex per resurs (filer, databaspaths)

### Kommando-whitelist
Endast dessa kommandon är tillåtna i orchestrator:
- `npm test` (med flaggor)
- `npm run build`
- `npm run lint`
- `node <script.js>` (endast lokala scripts)
- `git status`
- `git diff`

## Collaboration Protocol

### Handoff-flöde
1. **Cursor-analytiker** (Analyst) → Analyserar tasks
   - Handoff marker: `HANDOFF_TO_CODEX`
2. **Codex-implementerare** (Implementer) → Skapar implementation
   - Handoff marker: `RUN_TESTS`
3. **Verifierare** (Verifier) → Testar och validerar
   - Completion marker: `implementation verified successfully`

### Envelope Schema
Alla agent-svar följer ett normaliserat envelope-schema med:
- `plan`: Strukturerad beskrivning av planen
- `actions`: Konkreta åtgärder att utföra
- `diffs`: Filförändringar som diff-format
- `artifacts`: Genererade filer eller outputs
- `checks`: Verifieringssteg som ska köras
- `handoff`: Nästa roll (`analyst`, `implementer`, `verifier`, eller `done`)

## Kontraktshantering

### Kontraktsstatus
- `proposed`: Kontrakt skapat men inte accepterat
- `in_progress`: Arbete pågår
- `completed`: Klart och verifierat
- `rejected`: Avvisat eller misslyckades

### CLI-kommandon
```bash
npm run contracts:list              # Lista alla kontrakt
npm run contracts:view -- <id>      # Visa specifikt kontrakt
npm run contracts:history -- <id>   # Visa historik
```

## Session Recording

Varje orchestration-körning sparas i `data/orchestration-history/<sessionId>.json` med:
- **meta**: Task, timestamps, final envelope, success flag
- **history**: Turn-by-turn envelopes, check executions, responses

Dessa artifacts används för:
- Replay och audit trails
- Debugging av agent-interaktioner
- Seeding av nästa collaboration loop

## Dependencies

### Huvudberoenden
- `express`: HTTP server
- `axios`: HTTP client
- `cors`: CORS-stöd
- `better-sqlite3`: SQLite databas (mcp-server)
- `zod`: Schema validation
- `@modelcontextprotocol/sdk`: MCP SDK

### Dev Dependencies
- `jest`: Test framework
- `supertest`: HTTP assertions
- `eslint`: Code linting
- `typescript`: TypeScript compiler
- `nodemon`: Development auto-reload

## Workspace Management

### MCP Workspaces
- Workspaces definieras i `config/server.config.json`
- Använd `workspace_set` för att växla kontext
- Använd `workspace_list` för att se tillgängliga workspaces
- Alla file operations scopas till active workspace

## Dashboard

- Tillgänglig på `/dashboard`
- Real-time view av contracts, locks, messages och events
- Strömmar från `/events` endpoint
- Statiska assets i `dashboard/`-katalogen

## Bidragande

Vid implementering av nya features:
1. **Uppdatera kontraktsmodellen** om det påverkar task contracts
2. **Lägg till event types** för nya händelser i event stream
3. **Dokumentera i README** med API-exempel
4. **Uppdatera adapters** om det påverkar agent-samarbetet
5. **Lägg till CLI-stöd** för nya resurser om relevant
6. **Testa end-to-end** med orchestrator smoke test

## Kodexempel

### Skapa kontrakt via meddelande
```javascript
const response = await axios.post('/publish_message', {
  recipient: 'codex-agent',
  sender: 'cursor-agent',
  content: JSON.stringify({ task: 'Analyse TypeScript config' }),
  contract: {
    title: 'Analyse TypeScript config',
    initiator: 'cursor-agent',
    owner: 'codex-agent',
    priority: 'high',
    tags: ['analysis', 'typescript'],
    files: ['tsconfig.json']
  }
});
```

### Uppdatera kontraktsstatus
```javascript
await axios.patch(`/contracts/${contractId}/status`, {
  actor: 'codex-agent',
  status: 'in_progress',
  owner: 'codex-agent',
  note: 'Work started'
});
```

### Lyssna på events
```javascript
const eventSource = new EventSource('/events');
eventSource.addEventListener('contract.updated', (event) => {
  const data = JSON.parse(event.data);
  console.log('Contract updated:', data.contract);
});
```

## MCP Server Configuration

Se `mcp-server/config/server.config.json` för:
- `allowedPaths`: Filsystem whitelist
- `roles`: RBAC-konfiguration
- `rateLimits`: Rate limiting settings
- `safeCommands`: Command execution safelist
- `workspaces`: Named workspace definitions

## Environment Variables

- `PORT`: Server port (default: 3000)
- `MCP_SERVER_CONFIG`: Path till MCP server config
- `MCP_ROLE`: MCP server role (`readonly`, `developer`, `admin`)

## Dokumentation

- Huvuddokumentation: `README.md`
- Kontraktsdokumentation: `CONTRACTS.md`
- Uppgiftslista: `TODO.md`
- MCP Server: `mcp-server/README.md`
