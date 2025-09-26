import { z } from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import { FSWhitelist } from "../security/fsWhitelist.js";
import { LockRegistry } from "../security/locks.js";

export const dbQuerySchema = z.object({
  dbPath: z.string(),
  sql: z.string(),
  params: z.array(z.any()).default([]),
  timeoutMs: z.number().min(1).max(60000).default(5000)
});

export const dbExecSchema = z.object({
  dbPath: z.string(),
  sql: z.string(), // single statement preferred
  params: z.array(z.any()).default([]),
  timeoutMs: z.number().min(1).max(60000).default(5000)
});

export const dbMigrateSchema = z.object({
  dbPath: z.string(),
  schema: z.string(),
  timeoutMs: z.number().min(1).max(120000).default(10000)
});

function open(dbPath: string, timeoutMs: number) {
  const db = new Database(dbPath, { timeout: timeoutMs });
  return db;
}

export function createDBTools(whitelist: FSWhitelist, locks: LockRegistry) {
  async function ensurePath(p: string) {
    const abs = path.resolve(p);
    whitelist.ensureAllowed(abs);
    return abs;
  }

  async function db_query(input: z.infer<typeof dbQuerySchema>) {
    const abs = await ensurePath(input.dbPath);
    const unlock = await locks.getLock(abs).lock();
    try {
      const db = open(abs, input.timeoutMs);
      const stmt = db.prepare(input.sql);
      const rows = stmt.all(...input.params);
      db.close();
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    } finally {
      unlock();
    }
  }

  async function db_execute(input: z.infer<typeof dbExecSchema>) {
    const abs = await ensurePath(input.dbPath);
    const unlock = await locks.getLock(abs).lock();
    try {
      const db = open(abs, input.timeoutMs);
      if (input.params.length) {
        const stmt = db.prepare(input.sql);
        const info = stmt.run(...input.params);
        db.close();
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } else {
        const info = db.exec(input.sql);
        db.close();
        return { content: [{ type: "text", text: JSON.stringify(info ?? {}, null, 2) }] };
      }
    } finally {
      unlock();
    }
  }

  async function db_migrate(input: z.infer<typeof dbMigrateSchema>) {
    const abs = await ensurePath(input.dbPath);
    const unlock = await locks.getLock(abs).lock();
    try {
      const db = open(abs, input.timeoutMs);
      db.exec(input.schema);
      db.close();
      return { content: [{ type: "text", text: `Migration applied to ${abs}` }] };
    } finally {
      unlock();
    }
  }

  return { db_query, db_execute, db_migrate };
}