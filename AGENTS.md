# AGENTS.md

## Cursor Cloud specific instructions

### Services overview

Agent-Bridge is a single Node.js + TypeScript server (Express + WebSocket + SSE) on port 3000.
It uses embedded SQLite (`better-sqlite3`) — no external databases or Docker services needed.

Key commands are documented in `CLAUDE.md` under "Key commands" and in `package.json` scripts.

### Non-obvious caveats

- **Message schema**: `POST /publish_message` expects `{ content, sender, recipient }` — not `payload`/`from`/`to`. The WebSocket protocol uses `{ type, from, to, payload }` — the two schemas differ.
- **ACK schema**: `POST /ack_message` expects `{ ids: [...] }` (array), not `{ messageId }`.
- **Contract status transitions**: Contracts follow a strict state machine: `proposed → accepted → in_progress → completed`. You cannot skip states (e.g. `proposed → in_progress` is rejected).
- **Tests use in-memory SQLite**: `jest.setup.ts` sets `BRIDGE_DB_PATH=:memory:` so tests never touch the file-based DB.
- **Dev server cleanup**: `npm run dev` uses `ts-node` directly. Stop it with its PID (never `pkill -f`). The server creates `data/bridge.db` on first run.
- **No git hooks or pre-commit**: The repo has no Husky, lint-staged, or pre-commit config. Run `npm test && npm run lint` before committing.
- **Optional sub-packages**: `mcp-server/` and `vscode-extension/` each have their own `package.json` and `npm install`. They are not required for core development.
- **Autonomous agents require `ANTHROPIC_API_KEY`**: Without it, agent adapters return stub responses — the orchestrator still runs end-to-end.
