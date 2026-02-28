# Project Restructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize Agent-Bridge root and scripts/ into proper subfolders before the repo grows large.

**Architecture:** Use `git mv` throughout so git history is preserved. Fix all broken import paths after each move. Verify with `npm test` + `npm run lint` before committing each task.

**Tech Stack:** Node.js, TypeScript, Jest, git

---

## Task 1: Branch setup

**Files:**
- No file changes

**Step 1: Create branch from latest main**

```bash
git fetch origin main
git checkout -b refactor/project-restructure origin/main
```

**Step 2: Verify clean slate**

```bash
git status
npm test
```

Expected: working tree clean, all tests pass.

**Step 3: Commit design doc**

```bash
git add docs/plans/2026-02-28-project-restructure-design.md docs/plans/2026-02-28-project-restructure.md
git commit -m "docs: add project restructure design and implementation plan"
```

---

## Task 2: Move agents/ (root-level agent files)

**Files:**
- Create dir: `agents/`
- Move: `autonomous-codex-agent.js` → `agents/autonomous-codex-agent.js`
- Move: `autonomous-cursor-agent.js` → `agents/autonomous-cursor-agent.js`
- Move: `start-autonomous-agents.js` → `agents/start-autonomous-agents.js`
- Move: `agent-bridge-client.js` → `agents/agent-bridge-client.js`

**Step 1: Move with git mv**

```bash
mkdir agents
git mv autonomous-codex-agent.js agents/autonomous-codex-agent.js
git mv autonomous-cursor-agent.js agents/autonomous-cursor-agent.js
git mv start-autonomous-agents.js agents/start-autonomous-agents.js
git mv agent-bridge-client.js agents/agent-bridge-client.js
```

**Step 2: Fix utils/ imports in autonomous agents**

In `agents/autonomous-codex-agent.js`, change lines 7–8:
```js
// Before:
const { saveGeneratedFiles } = require('./utils/file-manager');
const { updateContractSafely, acknowledgeMessage } = require('./utils/contract-helpers');

// After:
const { saveGeneratedFiles } = require('../src/utils/file-manager');
const { updateContractSafely, acknowledgeMessage } = require('../src/utils/contract-helpers');
```

Same change in `agents/autonomous-cursor-agent.js` lines 7–8.

**Step 3: Fix cross-agent imports in start-autonomous-agents.js**

In `agents/start-autonomous-agents.js`, lines 4–5 become:
```js
// Before:
const AutonomousCursorAgent = require("./autonomous-cursor-agent.js");
const AutonomousCodexAgent = require("./autonomous-codex-agent.js");

// After: (no change — same folder, relative paths still correct)
const AutonomousCursorAgent = require("./autonomous-cursor-agent.js");
const AutonomousCodexAgent = require("./autonomous-codex-agent.js");
```

No change needed here.

**Step 4: Commit**

```bash
git add agents/
git commit -m "refactor: move root-level agent files into agents/"
```

---

## Task 3: Move bin/ (CLI tools)

**Files:**
- Create dir: `bin/`
- Move: `contract-cli.js` → `bin/contract-cli.js`

**Step 1: Move**

```bash
mkdir bin
git mv contract-cli.js bin/contract-cli.js
```

**Step 2: Update package.json scripts** (lines 13–15)

```json
"contracts:list": "node bin/contract-cli.js list",
"contracts:view": "node bin/contract-cli.js view",
"contracts:history": "node bin/contract-cli.js history",
```

**Step 3: Commit**

```bash
git add bin/ package.json
git commit -m "refactor: move contract-cli.js into bin/"
```

---

## Task 4: Move config/ and examples/

**Files:**
- Create dir: `config/`
- Move: `codex-mcp-config.json` → `config/codex-mcp-config.json`
- Create dir: `examples/`
- Move: `hello-world.html` → `examples/hello-world.html`

**Step 1: Move**

```bash
mkdir config examples
git mv codex-mcp-config.json config/codex-mcp-config.json
git mv hello-world.html examples/hello-world.html
```

**Step 2: Check for references to codex-mcp-config.json**

```bash
grep -r "codex-mcp-config" --include="*.json" --include="*.js" --include="*.ts" --include="*.md" . | grep -v node_modules
```

Update any paths found.

**Step 3: Commit**

```bash
git add config/ examples/
git commit -m "refactor: move config and example files into config/ and examples/"
```

---

## Task 5: Restructure scripts/ into subfolders

**Files:**
- Create dirs: `scripts/agents/`, `scripts/orchestration/`, `scripts/smoke/`
- Move: `scripts/agent-worker.mjs` → `scripts/agents/agent-worker.mjs`
- Move: `scripts/run-agents.mjs` → `scripts/agents/run-agents.mjs`
- Move: `scripts/orchestrator.mjs` → `scripts/orchestration/orchestrator.mjs`
- Move: `scripts/collaboration-protocol.mjs` → `scripts/orchestration/collaboration-protocol.mjs`
- Move: `scripts/session-recorder.mjs` → `scripts/orchestration/session-recorder.mjs`
- Move: `scripts/smoke-orchestrator.mjs` → `scripts/smoke/smoke-orchestrator.mjs`
- Move: `scripts/contract-smoke-test.js` → `scripts/smoke/contract-smoke-test.js`
- Move: `scripts/hello-world.js` → `scripts/smoke/hello-world.js`

**Step 1: Move**

```bash
mkdir scripts/agents scripts/orchestration scripts/smoke
git mv scripts/agent-worker.mjs scripts/agents/agent-worker.mjs
git mv scripts/run-agents.mjs scripts/agents/run-agents.mjs
git mv scripts/orchestrator.mjs scripts/orchestration/orchestrator.mjs
git mv scripts/collaboration-protocol.mjs scripts/orchestration/collaboration-protocol.mjs
git mv scripts/session-recorder.mjs scripts/orchestration/session-recorder.mjs
git mv scripts/smoke-orchestrator.mjs scripts/smoke/smoke-orchestrator.mjs
git mv scripts/contract-smoke-test.js scripts/smoke/contract-smoke-test.js
git mv scripts/hello-world.js scripts/smoke/hello-world.js
```

**Step 2: Fix imports in scripts/agents/run-agents.mjs**

Line 22: `import { AgentWorker } from './agent-worker.mjs'` — **no change needed** (same folder).

**Step 3: Fix imports in scripts/orchestration/orchestrator.mjs**

Lines 10, 16: `./session-recorder.mjs` and `./collaboration-protocol.mjs` — **no change needed** (same folder).

**Step 4: Fix imports in scripts/smoke/smoke-orchestrator.mjs**

```js
// Before:
import { NodeOrchestrator } from './orchestrator.mjs';
// ...
const { runCmd } = await import('./orchestrator.mjs');

// After:
import { NodeOrchestrator } from '../orchestration/orchestrator.mjs';
// ...
const { runCmd } = await import('../orchestration/orchestrator.mjs');
```

**Step 5: Fix imports in scripts/smoke/contract-smoke-test.js** (lines 247–248)

```js
// Before:
const AutonomousCursorAgent = require('../autonomous-cursor-agent.js');
const AutonomousCodexAgent = require('../autonomous-codex-agent.js');

// After:
const AutonomousCursorAgent = require('../../agents/autonomous-cursor-agent.js');
const AutonomousCodexAgent = require('../../agents/autonomous-codex-agent.js');
```

**Step 6: Update package.json scripts**

```json
"test:contracts": "node scripts/smoke/contract-smoke-test.js",
"test:orchestrator": "node scripts/smoke/smoke-orchestrator.mjs",
"orchestrate": "node scripts/orchestration/orchestrator.mjs",
"agents": "node scripts/agents/run-agents.mjs",
```

**Step 7: Commit**

```bash
git add scripts/ package.json
git commit -m "refactor: reorganize scripts/ into agents/, orchestration/, smoke/ subfolders"
```

---

## Task 6: Move utils/ → src/utils/

**Files:**
- Create dir: `src/utils/`
- Move: `utils/contract-helpers.js` → `src/utils/contract-helpers.js`
- Move: `utils/file-manager.js` → `src/utils/file-manager.js`
- Remove: `utils/` (empty after move)

**Step 1: Move**

```bash
mkdir src/utils
git mv utils/contract-helpers.js src/utils/contract-helpers.js
git mv utils/file-manager.js src/utils/file-manager.js
rmdir utils
```

**Step 2: Verify agents/ already have correct paths**

From Task 2, `agents/autonomous-*.js` already use `../src/utils/` — correct.

**Step 3: Check for any remaining references to utils/**

```bash
grep -r "require.*['\"].*utils/" --include="*.js" --include="*.mjs" --include="*.ts" . | grep -v node_modules | grep -v src/utils
```

Expected: no output.

**Step 4: Commit**

```bash
git add src/utils/
git commit -m "refactor: move utils/ into src/utils/"
```

---

## Task 7: Verify and update package.json agents script

**Files:**
- Modify: `package.json`

**Step 1: Check current agents script**

```bash
grep "agents" package.json
```

The `"agents"` script currently runs `scripts/run-agents.mjs`. Verify it now points to `scripts/agents/run-agents.mjs`.

**Step 2: Also check start-autonomous-agents path if referenced**

```bash
grep -r "start-autonomous-agents" package.json scripts/ src/ 2>/dev/null | grep -v node_modules
```

Update any paths found.

---

## Task 8: Full verification

**Step 1: Run lint**

```bash
npm run lint
```

Expected: 0 TypeScript errors.

**Step 2: Run tests**

```bash
npm test
```

Expected: all tests pass, no open-handle warnings.

**Step 3: Verify final structure**

```bash
find . -maxdepth 3 -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './mcp-server/node_modules/*' | sort
```

**Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "refactor: fix remaining import paths after restructure"
```

---

## Task 9: Push PR and merge

**Step 1: Push branch**

```bash
git push -u origin refactor/project-restructure
```

**Step 2: Create PR**

```bash
gh pr create --base main --head refactor/project-restructure \
  --title "refactor: reorganize project structure into proper subfolders" \
  --body "Moves root-level agent files, CLI, config, and examples into dedicated folders. Splits scripts/ into agents/, orchestration/, smoke/. Merges utils/ into src/utils/. All import paths updated. CI verified."
```

**Step 3: Merge after CI passes**

```bash
gh pr merge --merge
```

**Step 4: Delete branch**

```bash
gh api -X DELETE repos/JohnCCarter/Agent-Bridge/git/refs/heads/refactor/project-restructure
```
