/**
 * Agent Tools — read-only filesystem and bridge tools for AgentWorker instances.
 *
 * Security: all file paths are sanitized to prevent directory traversal.
 * Nothing writes, deletes, or executes arbitrary shell commands.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Project root = where the process was started from (i.e., the repo root)
const PROJECT_ROOT = path.resolve(process.cwd());
const MAX_FILE_BYTES = 50 * 1024; // 50 KB hard cap for read_file

/**
 * Resolve userPath relative to PROJECT_ROOT and verify it doesn't escape.
 * Throws if path traversal is attempted.
 */
function safePath(userPath) {
  if (path.isAbsolute(userPath)) {
    throw new Error(`Absolute paths not allowed: ${userPath}`);
  }
  const resolved = path.resolve(PROJECT_ROOT, userPath);
  // On Windows path.sep is '\\' but both separators are valid; normalise
  const rootWithSep = PROJECT_ROOT.endsWith(path.sep) ? PROJECT_ROOT : PROJECT_ROOT + path.sep;
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}

// ── Tool implementations ────────────────────────────────────────────────────

export async function read_file({ path: userPath }) {
  let safe;
  try {
    safe = safePath(userPath);
  } catch (err) {
    return `Error: ${err.message}`;
  }
  let buf;
  try {
    buf = await fs.readFile(safe);
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
  if (buf.length > MAX_FILE_BYTES) {
    return buf.slice(0, MAX_FILE_BYTES).toString('utf8') + '\n\n[truncated — file exceeds 50 KB]';
  }
  return buf.toString('utf8');
}

export async function list_files({ path: userPath = '.' }) {
  let safe;
  try {
    safe = safePath(userPath);
  } catch (err) {
    return `Error: ${err.message}`;
  }
  let entries;
  try {
    entries = await fs.readdir(safe, { withFileTypes: true });
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
  return entries
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n');
}

/**
 * Recursively search files for a pattern using Node.js (no shell dependency).
 * Returns matching lines in "file:line: content" format, up to 100 matches.
 */
export async function search_code({ pattern, path: userPath = '.' }) {
  const safe = safePath(userPath);
  const regex = new RegExp(pattern, 'i');
  const results = [];

  async function walk(dir) {
    if (results.length >= 100) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 100) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        await walk(full);
      } else if (/\.(ts|mjs|js|json|md)$/.test(entry.name)) {
        let content;
        try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        const rel = path.relative(PROJECT_ROOT, full);
        lines.forEach((line, i) => {
          if (results.length < 100 && regex.test(line)) {
            results.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }

  await walk(safe);
  return results.length > 0 ? results.join('\n') : '(no matches)';
}

export async function run_tests({ pattern = '' } = {}) {
  const args = ['test', '--forceExit', '--no-coverage'];
  if (pattern) args.push('--testNamePattern', pattern);
  try {
    const { stdout, stderr } = await execFileAsync('npm', args, {
      timeout: 90_000,
      cwd: PROJECT_ROOT,
      shell: true,       // needed on Windows for npm
    });
    return (stdout + stderr).slice(-8000); // last 8 KB (test summary is at the end)
  } catch (err) {
    // npm test exits non-zero when tests fail — still return the output
    return ((err.stdout || '') + (err.stderr || '')).slice(-8000);
  }
}

export async function get_contracts() {
  const PORT = process.env.PORT || 3000;
  const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
  try {
    const res = await fetch(`http://localhost:${PORT}/contracts`, { headers });
    if (!res.ok) return `Error fetching contracts: ${res.status} ${res.statusText}`;
    const data = await res.json();
    if (!data.contracts || data.contracts.length === 0) return '(no contracts)';
    return JSON.stringify(data.contracts, null, 2);
  } catch (err) {
    return `Error reaching bridge: ${err.message}`;
  }
}

// ── Tool registry for callClaude ────────────────────────────────────────────

/**
 * Map of tool name → implementation function.
 * callClaude uses this to dispatch tool_use requests from Claude.
 */
export const TOOL_IMPLEMENTATIONS = {
  read_file,
  list_files,
  search_code,
  run_tests,
  get_contracts,
};

/**
 * Anthropic tool definitions (schema) for each tool.
 * Pass a subset of TOOL_DEFINITIONS to callClaude() to enable specific tools.
 */
export const TOOL_DEFINITIONS = {
  read_file: {
    name: 'read_file',
    description: 'Read the contents of a file in the project. Use this to understand existing code, configuration, or documentation before planning or reviewing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root, e.g. "src/index.ts"' },
      },
      required: ['path'],
    },
  },

  list_files: {
    name: 'list_files',
    description: 'List files and directories at a given path. Use this to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to project root, e.g. "src/adapters"' },
      },
    },
  },

  search_code: {
    name: 'search_code',
    description: 'Search for a pattern (case-insensitive regex) across all .ts, .mjs, .js, .json, and .md files. Returns up to 100 matching lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for, e.g. "auth|jwt|bearer"' },
        path:    { type: 'string', description: 'Directory to search in (default: project root)' },
      },
      required: ['pattern'],
    },
  },

  run_tests: {
    name: 'run_tests',
    description: 'Run the Jest test suite (npm test) and return the output. Use this to verify that existing tests pass. Optionally filter by test name pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional Jest --testNamePattern filter' },
      },
    },
  },

  get_contracts: {
    name: 'get_contracts',
    description: 'Fetch all current task contracts from the Agent-Bridge server. Use this to understand what tasks are tracked and their status.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
};
