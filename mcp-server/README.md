# Agent Bridge MCP Server (TypeScript/Node)

En säker MCP-server för att koppla samman “Codex” och Cursor.

## Nytt i v0.2.0
- code_analysis via ESLint (med/fall-back utan projektkonfiguration)
- dependency_scan (missing/unused, versions och latest från npm)
- SQLite-stöd: db_query, db_execute, db_migrate

## Installation

```bash
cd mcp-server
pnpm i # eller npm i / yarn
pnpm build
```

## Körning lokalt

- Utvecklingsläge (hot-reload):
```bash
pnpm dev
```

- Kompilerad:
```bash
pnpm build
pnpm start
```

## Konfiguration

Se `config/server.config.json`
- `allowedPaths`: vitlista för filsystem
- `roles`: RBAC (readonly/developer/admin)
- `rateLimits`: rate limiting per verktyg
- `safeCommands`: safelist för `command_exec`
- `workspaces`: namngivna arbetsytor

Env:
- `MCP_SERVER_CONFIG` pekar på konfigfil
- `MCP_ROLE` (readonly|developer|admin)

## Cursor konfiguration (exempel)

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["${workspaceFolder}/mcp-server/dist/index.js"],
      "env": {
        "MCP_SERVER_CONFIG": "${workspaceFolder}/mcp-server/config/server.config.json",
        "MCP_ROLE": "developer"
      }
    }
  }
}
```

## Verktyg

- code_analysis
  - Input:
    ```json
    { "patterns": ["src/**/*.{ts,tsx,js,jsx}"], "fix": false, "formatter": "stylish", "useProjectEslint": true, "cwd": "${workspace}" }
    ```
  - Använder projektets ESLint-config om `useProjectEslint = true`, annars en minimal fallback.
  - Resultat: summering + formatterad rapport.

- dependency_scan
  - Input:
    ```json
    { "cwd": "${workspace}", "scanPaths": ["src"], "includeDev": false, "checkLatest": true }
    ```
  - Rapporterar `missing`, `unused` och `versions` (declared/installed/latest).

- dependency_add
  - Input:
    ```json
    { "cwd": "${workspace}", "pkg": "lodash", "dev": false, "manager": "npm" }
    ```
  - Returnerar ett säkert installationskommando.

- db_query
  - Input:
    ```json
    { "dbPath": "${workspace}/.data/app.db", "sql": "SELECT * FROM tasks WHERE status = ?", "params": ["todo"] }
    ```
  - Returnerar rader som JSON.

- db_execute
  - Input:
    ```json
    { "dbPath": "${workspace}/.data/app.db", "sql": "INSERT INTO tasks (id,title,status,progress) VALUES (?,?,?,?)", "params": ["t1","Title","todo",0] }
    ```

- db_migrate
  - Input:
    ```json
    {
      "dbPath": "${workspace}/.data/app.db",
      "schema": "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, progress INTEGER);"
    }
    ```

Övriga verktyg finns kvar: ping, message, status, file_read/write/dir_list, workspace_list/set, http_fetch, command_exec, git_op, task_* m.fl.

## Säkerhet
- RBAC: styr verktygsåtkomst per roll
- Whitelist: alla paths prövas mot `allowedPaths`
- Låsning: per-resurs mutex (filer, dbPath)
- Rate limiting: per-verktyg token bucket
- Input-validering: zod-scheman