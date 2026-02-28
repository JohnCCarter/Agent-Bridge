# Project Restructure Design — 2026-02-28

## Goal

Reorganize the Agent-Bridge root and scripts/ folder before the repo grows further.
No changes to src/ core logic, tests, or sub-packages (dashboard/, mcp-server/, vscode-extension/).

## Approved Approach: B (Full)

### New top-level folders

| Folder | Contents | Source |
|--------|----------|--------|
| `agents/` | Agent implementations + client library | root `autonomous-*.js`, `start-autonomous-agents.js`, `agent-bridge-client.js` |
| `bin/` | CLI entry points | root `contract-cli.js` |
| `config/` | Config files | root `codex-mcp-config.json` |
| `examples/` | Demo files | root `hello-world.html` |

### scripts/ subfolders

| Subfolder | Files |
|-----------|-------|
| `scripts/agents/` | `agent-worker.mjs`, `run-agents.mjs` |
| `scripts/orchestration/` | `orchestrator.mjs`, `collaboration-protocol.mjs`, `session-recorder.mjs` |
| `scripts/smoke/` | `contract-smoke-test.js`, `smoke-orchestrator.mjs`, `hello-world.js` |

### src/ additions

| Subfolder | Files | Source |
|-----------|-------|--------|
| `src/utils/` | `contract-helpers.js`, `file-manager.js` | root `utils/` (removed) |

### Files not moved

- `package.json`, `package-lock.json`, `tsconfig.json`, `jest.config.js` — must stay in root
- `README.md`, `CLAUDE.md`, `.gitignore`, `.eslintrc.cjs` — must stay in root
- `src/*.ts`, `src/adapters/` — untouched
- `dashboard/`, `docs/`, `mcp-server/`, `vscode-extension/` — untouched

## Import path updates required

| File | What changes |
|------|-------------|
| `package.json` scripts | `agents`, `test:contracts`, `test:orchestrator`, `orchestrate`, `contracts:*` paths |
| `scripts/agents/run-agents.mjs` | import path to `agent-worker.mjs` |
| `scripts/orchestration/orchestrator.mjs` | imports of `collaboration-protocol.mjs`, `session-recorder.mjs` |
| `scripts/smoke/smoke-orchestrator.mjs` | import path to orchestrator |
| Any file importing from `utils/` | updated to `src/utils/` |

## Success criteria

- All `npm run *` scripts still work after restructure
- `npm test` passes (no broken imports)
- `npm run lint` passes (no TypeScript errors)
- Git history preserved via `git mv` (not copy/delete)
- CI green on main
