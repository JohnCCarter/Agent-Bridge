import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/transport/node";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "./utils/logger.js";
import { RBAC } from "./security/rbac.js";
import { validate } from "./security/validation.js";
import { FSWhitelist } from "./security/fsWhitelist.js";
import { CommandPolicy } from "./security/commandPolicy.js";
import { RateLimiter } from "./security/rateLimiter.js";
import { LockRegistry } from "./security/locks.js";

import { ping, pingSchema } from "./capabilities/ping.js";
import { relayMessage, messageSchema } from "./capabilities/message.js";
import { status } from "./capabilities/status.js";
import { createFSTools } from "./capabilities/fs.js";
import { createWorkspaceTools } from "./capabilities/workspace.js";
import { http_fetch, httpFetchSchema } from "./capabilities/http.js";
import { createCommandTools } from "./capabilities/commands.js";
import { createGitTools } from "./capabilities/git.js";
import { code_generate, codeGenerateSchema } from "./capabilities/code.js";
import { task_create, task_list, task_update, createTaskSchema, updateTaskSchema } from "./capabilities/tasks.js";
import { dependency_add, dependency_scan, pkgAddSchema, dependencyScanSchema } from "./capabilities/dependencies.js";
import { contract_create, contract_list } from "./capabilities/contracts.js";
import { createDBTools, dbExecSchema, dbQuerySchema, dbMigrateSchema } from "./capabilities/db.js";
import { code_analysis, codeAnalysisSchema } from "./capabilities/analysis.js";

type Config = {
  serverName: string;
  version: string;
  allowedPaths: string[];
  safeCommands: Record<string, { args: string[]; timeoutMs: number }>;
  rateLimits: Record<string, { capacity: number; intervalMs: number }>;
  roles: Record<string, { allowedTools: "*" | string[] }>;
  workspaces: Record<string, string>;
};

async function loadConfig(): Promise<Config> {
  const configPath = process.env.MCP_SERVER_CONFIG ?? path.resolve("config/server.config.json");
  const buf = await fs.readFile(configPath, "utf8");
  const raw = JSON.parse(buf);
  const schema = z.object({
    serverName: z.string(),
    version: z.string(),
    allowedPaths: z.array(z.string()),
    safeCommands: z.record(z.string(), z.object({ args: z.array(z.string()), timeoutMs: z.number() })),
    rateLimits: z.record(z.string(), z.object({ capacity: z.number(), intervalMs: z.number() })),
    roles: z.record(z.string(), z.object({ allowedTools: z.union([z.literal("*"), z.array(z.string())]) })),
    workspaces: z.record(z.string(), z.string())
  });
  return validate<Config>(schema, raw);
}

function ensureAllowed(rbac: RBAC, limiter: RateLimiter, toolName: string) {
  if (!rbac.canUse(toolName)) {
    throw new Error(`RBAC: role not permitted to use tool: ${toolName}`);
  }
  limiter.ensure(toolName);
}

async function main() {
  const config = await loadConfig();
  const role = process.env.MCP_ROLE ?? "developer";
  const rbac = new RBAC(config as any, role);
  const whitelist = new FSWhitelist(config.allowedPaths);
  const commandPolicy = new CommandPolicy(config.safeCommands);
  const limiter = new RateLimiter(config.rateLimits);
  const locks = new LockRegistry();

  const server = new Server(
    { name: config.serverName, version: config.version },
    { capabilities: { tools: {} } }
  );

  // ping/echo
  server.tool(
    "ping",
    { description: "Health check echo", inputSchema: pingSchema },
    async (input) => {
      ensureAllowed(rbac, limiter, "ping");
      return ping(input);
    }
  );

  // message_passing
  server.tool(
    "message",
    { description: "Relay a message", inputSchema: messageSchema },
    async (input) => {
      ensureAllowed(rbac, limiter, "message");
      return relayMessage(input);
    }
  );

  // status_reporting
  server.tool("status", { description: "Server status", inputSchema: z.object({}).optional() }, async () => {
    ensureAllowed(rbac, limiter, "status");
    return status();
  });

  // file_system_access
  const fsTools = createFSTools(whitelist, locks);
  server.tool("file_read", { description: "Read file", inputSchema: fsTools.readSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "file_system_access");
    return fsTools.file_read(input);
  });
  server.tool("file_write", { description: "Write file", inputSchema: fsTools.writeSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "file_system_access");
    return fsTools.file_write(input);
  });
  server.tool("dir_list", { description: "List directory", inputSchema: fsTools.listSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "file_system_access");
    return fsTools.dir_list(input);
  });

  // workspace_management
  const wsTools = createWorkspaceTools(config.workspaces);
  server.tool("workspace_list", { description: "List workspaces", inputSchema: z.object({}).optional() }, async () => {
    ensureAllowed(rbac, limiter, "workspace_list");
    return wsTools.list();
  });
  server.tool("workspace_set", { description: "Set active workspace", inputSchema: wsTools.setSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "workspace_set");
    return wsTools.set(input);
  });

  // http_fetch
  server.tool("http_fetch", { description: "HTTP fetch", inputSchema: httpFetchSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "http_fetch");
    return http_fetch(input);
  });

  // command_execution
  const cmdTools = createCommandTools(commandPolicy, locks);
  server.tool("command_exec", { description: "Execute safe command", inputSchema: cmdTools.schema }, async (input) => {
    ensureAllowed(rbac, limiter, "command_execution");
    return cmdTools.command_exec(input);
  });

  // git_operations
  const gitTools = createGitTools(commandPolicy, locks);
  server.tool("git_op", { description: "Run safe git operation", inputSchema: gitTools.schema }, async (input) => {
    ensureAllowed(rbac, limiter, "git_operations");
    return gitTools.git_op(input);
  });

  // code_generation
  server.tool("code_generate", { description: "Generate or overwrite a file", inputSchema: codeGenerateSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "code_generation");
    return code_generate(input);
  });

  // code_analysis (ESLint)
  server.tool("code_analysis", { description: "Analyze code with ESLint", inputSchema: codeAnalysisSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "code_analysis");
    return code_analysis(input, whitelist);
  });

  // task_delegation / progress_tracking (minimal)
  server.tool("task_create", { description: "Create task", inputSchema: createTaskSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "task_delegation");
    return task_create(input);
  });
  server.tool("task_update", { description: "Update task", inputSchema: updateTaskSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "progress_tracking");
    return task_update(input);
  });
  server.tool("task_list", { description: "List tasks", inputSchema: z.object({}).optional() }, async () => {
    ensureAllowed(rbac, limiter, "progress_tracking");
    return task_list();
  });

  // dependency_management
  server.tool("dependency_add", { description: "Suggest install for a package", inputSchema: pkgAddSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "dependency_management");
    return dependency_add(input);
  });
  server.tool("dependency_scan", { description: "Scan dependencies usage and versions", inputSchema: dependencyScanSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "dependency_management");
    return dependency_scan(input, whitelist);
  });

  // contract_management (stub)
  server.tool("contract_create", { description: "Create contract (stub)", inputSchema: z.object({}).optional() }, async () => {
    ensureAllowed(rbac, limiter, "contract_management");
    return contract_create();
  });
  server.tool("contract_list", { description: "List contracts (stub)", inputSchema: z.object({}).optional() }, async () => {
    ensureAllowed(rbac, limiter, "contract_management");
    return contract_list();
  });

  // database_access (SQLite)
  const dbTools = createDBTools(whitelist, locks);
  server.tool("db_query", { description: "Execute SELECT and return rows", inputSchema: dbQuerySchema }, async (input) => {
    ensureAllowed(rbac, limiter, "database_access");
    return dbTools.db_query(input);
  });
  server.tool("db_execute", { description: "Execute INSERT/UPDATE/DELETE", inputSchema: dbExecSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "database_access");
    return dbTools.db_execute(input);
  });
  server.tool("db_migrate", { description: "Apply SQL migration", inputSchema: dbMigrateSchema }, async (input) => {
    ensureAllowed(rbac, limiter, "database_access");
    return dbTools.db_migrate(input);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started", { role: rbac.getRole(), name: config.serverName, version: config.version });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});