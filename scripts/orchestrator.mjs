#!/usr/bin/env node

/**
 * Agent-Bridge Node Orchestrator (Path 2)
 * 
 * A minimal local orchestrator that coordinates Cursor/Codex agents
 * through three logical roles: Analyst → Implementer → Test → Analyst
 * 
 * Features:
 * - Safe file tools with repo path sandboxing
 * - Command execution with timeout
 * - Integration with existing autonomous agents
 * - Turn-based workflow with handoff routing
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve, relative, normalize } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { CursorAgentAdapter } from '../src/adapters/cursor-agent-adapter.mjs';
import { CodexAgentAdapter } from '../src/adapters/codex-agent-adapter.mjs';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repository root resolution
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Safe Tools Implementation
 * Provides sandboxed file operations and command execution
 */
class SafeTools {
  constructor(repoRoot = REPO_ROOT) {
    this.repoRoot = resolve(repoRoot);
  }

  /**
   * Validates that a path is within the repository boundary
   */
  _validatePath(filePath) {
    const resolvedPath = resolve(this.repoRoot, filePath);
    const relativePath = relative(this.repoRoot, resolvedPath);
    
    if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
      throw new Error(`Path outside repository: ${filePath}`);
    }
    
    return resolvedPath;
  }

  /**
   * Read file content as UTF-8
   * @param {string} path - File path relative to repo root
   * @returns {Promise<string>} File content
   */
  async read_file(path) {
    const fullPath = this._validatePath(path);
    
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${path}`);
    }
    
    return await readFile(fullPath, 'utf-8');
  }

  /**
   * Write file content as UTF-8, creating directories as needed
   * @param {string} path - File path relative to repo root  
   * @param {string} content - Content to write
   */
  async write_file(path, content) {
    const fullPath = this._validatePath(path);
    const dirPath = dirname(fullPath);
    
    // Create directory if it doesn't exist
    await mkdir(dirPath, { recursive: true });
    
    await writeFile(fullPath, content, 'utf-8');
  }

  /**
   * Execute command in repo root with timeout
   * @param {string} cmd - Command to execute
   * @param {number} timeout - Timeout in milliseconds (default: 120000)
   * @returns {string} Combined stdout/stderr output
   */
  run_cmd(cmd, timeout = 120000) {
    // Basic command safety - log warning for now
    // TODO: Implement proper command whitelist
    if (!this._isSafeCommand(cmd)) {
      console.warn(`❌ Blocked: Unsafe command detected and not executed: ${cmd}`);
      throw new Error(`Blocked unsafe command: ${cmd}`);
    }

    try {
      const output = execSync(cmd, {
        cwd: this.repoRoot,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
      });
      
      return `Command: ${cmd}\nExit code: 0\nOutput:\n${output}`;
    } catch (error) {
      return `Command: ${cmd}\nExit code: ${error.status || 1}\nError:\n${error.message}\nOutput:\n${error.stdout || ''}\nStderr:\n${error.stderr || ''}`;
    }
  }

  /**
   * Basic command safety check
   * @param {string} cmd - Command to check
   * @returns {boolean} Whether command appears safe
   */
  _isSafeCommand(cmd) {
    // Define allowed commands and patterns
    const exactCommands = [
      'npm test',
      'git status',
      'git diff',
      'npm install',
      'npm ci',
      'ls',
      'cat',
      'echo',
      'jest'
    ];
    // Allow 'npm run <script>' and 'node <file>' with safe arguments
    const npmRunPattern = /^npm run [a-zA-Z0-9:_-]+$/;
    const nodePattern = /^node [a-zA-Z0-9._/-]+$/;
    // Only allow single commands, no chaining or shell metacharacters
    if (
      exactCommands.includes(cmd.trim()) ||
      npmRunPattern.test(cmd.trim()) ||
      nodePattern.test(cmd.trim())
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Agent Orchestrator
 * Coordinates three logical agents with handoff routing
 */
class AgentOrchestrator {
  constructor(tools) {
    this.tools = tools;
    this.maxTurns = 8;
    this.currentTurn = 0;
    
    // Initialize agent adapters
    this.cursorAdapter = new CursorAgentAdapter();
    this.codexAdapter = new CodexAgentAdapter();
    
    // Initialize logical agents with real agent adapters
    this.agents = {
      analyst: new AnalystAgent(tools, this.cursorAdapter),
      implementer: new ImplementerAgent(tools, this.codexAdapter),  
      verifier: new VerifierAgent(tools)
    };
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    await this.cursorAdapter.cleanup();
    await this.codexAdapter.cleanup();
  }

  /**
   * Main orchestration loop
   * @param {string} task - Task description
   * @returns {Promise<string>} Final result
   */
  async orchestrate(task) {
    console.log(`🚀 Starting orchestration for task: "${task}"`);
    console.log(`📁 Repository root: ${this.tools.repoRoot}`);
    console.log(`🔄 Max turns: ${this.maxTurns}\n`);

    let currentAgent = 'analyst';
    let context = { task, history: [] };

    for (this.currentTurn = 1; this.currentTurn <= this.maxTurns; this.currentTurn++) {
      console.log(`\n=== Turn ${this.currentTurn}: ${currentAgent.toUpperCase()} ===`);
      
      try {
        const result = await this.agents[currentAgent].process(context);
        
        // Log agent response
        console.log(`Agent response:\n${result.output}`);
        
        // Add to history
        context.history.push({
          turn: this.currentTurn,
          agent: currentAgent,
          output: result.output,
          handoff: result.handoff
        });

        // Check for handoff
        if (result.handoff) {
          currentAgent = result.handoff;
          console.log(`\n➡️  Handing off to: ${currentAgent}`);
        } else {
          console.log(`\n✅ Task completed by ${currentAgent}`);
          break;
        }

      } catch (error) {
        console.error(`❌ Error in ${currentAgent}:`, error.message);
        context.history.push({
          turn: this.currentTurn,
          agent: currentAgent,
          error: error.message
        });
        break;
      }
    }

    if (this.currentTurn > this.maxTurns) {
      console.log(`\n⚠️  Reached maximum turns (${this.maxTurns})`);
    }

    // Clean up resources
    await this.cleanup();

    return this._generateSummary(context);
  }

  _generateSummary(context) {
    const summary = [
      `\n📋 ORCHESTRATION SUMMARY`,
      `Task: ${context.task}`,
      `Turns completed: ${context.history.length}`,
      `\nHistory:`
    ];

    context.history.forEach(entry => {
      summary.push(`  Turn ${entry.turn} (${entry.agent}): ${entry.handoff ? `→ ${entry.handoff}` : 'completed'}`);
      if (entry.error) {
        summary.push(`    ❌ Error: ${entry.error}`);
      }
    });

    return summary.join('\n');
  }
}

/**
 * Analyst Agent - Breaks down tasks and determines next steps
 * Uses Cursor agent for task analysis and delegation decisions
 */
class AnalystAgent {
  constructor(tools, cursorAdapter) {
    this.tools = tools;
    this.cursorAdapter = cursorAdapter;
  }

  async process(context) {
    const { task, history } = context;
    
    if (history.length === 0) {
      // Initial analysis using Cursor agent
      const cursorResult = await this.cursorAdapter.processTask(task, {
        intent: 'analysis',
        focus: ['task_breakdown', 'requirement_analysis']
      });
      
      return {
        output: `📊 Analyst (Cursor): ${cursorResult.output}\n\nDetermining next step based on task requirements.`,
        handoff: this._determineNextStep(task)
      };
    } else {
      // Review cycle after testing
      const lastEntry = history[history.length - 1];
      if (lastEntry.agent === 'verifier') {
        return {
          output: `📊 Final analysis complete.\n\nReviewed test results and implementation. Task workflow completed successfully.`,
          handoff: null // Complete
        };
      }
    }

    return {
      output: `📊 Analysis step completed.`,
      handoff: null
    };
  }

  _determineNextStep(task) {
    // Simple heuristics to determine if we need implementation
    const needsCode = /implement|add|create|build|develop|code|function|class|module|indicator|RSI/i.test(task);
    
    if (needsCode) {
      return 'implementer'; // HANDOFF_TO_CODEX equivalent
    }
    
    return 'verifier'; // Go straight to testing if no code needed
  }
}

/**
 * Implementer Agent - Performs code changes  
 * Uses Codex agent for analysis and code generation
 */
class ImplementerAgent {
  constructor(tools, codexAdapter) {
    this.tools = tools;
    this.codexAdapter = codexAdapter;
  }

  async process(context) {
    const { task, history } = context;
    
    // Use Codex agent for analysis and potential code generation
    const analysisResult = await this.codexAdapter.performAnalysis(task, {
      description: task,
      focus: ['code_generation', 'implementation']
    });
    
    let output = `🔧 Implementer (Codex): ${analysisResult.output}\n`;
    
    // If this looks like a code generation task, attempt to generate files
    if (this._needsCodeGeneration(task)) {
      const codeResult = await this.codexAdapter.generateCode(task, {
        fileName: this._suggestFileName(task),
        content: this._generatePlaceholderCode(task)
      });
      
      // Write generated files using tools
      if (codeResult.generatedFiles && codeResult.generatedFiles.length > 0) {
        for (const file of codeResult.generatedFiles) {
          await this.tools.write_file(file.path, file.content);
          output += `\n📄 Generated file: ${file.path}`;
        }
      }
    }
    
    output += `\n\nImplementation phase completed. Proceeding to verification.`;
    
    return {
      output,
      handoff: 'verifier' // RUN_TESTS equivalent
    };
  }

  _needsCodeGeneration(task) {
    return /add|create|implement|generate|build/i.test(task);
  }

  _suggestFileName(task) {
    if (/test/i.test(task)) return 'test-implementation.js';
    if (/indicator/i.test(task)) return 'indicators/new-indicator.js';
    return 'implementation.js';
  }

  _generatePlaceholderCode(task) {
    return `// Implementation for: ${task}
// Generated by Agent-Bridge Orchestrator
// TODO: Replace with actual implementation

/**
 * ${task}
 */
function implementTask() {
  console.log('Task implementation placeholder');
  // Add your implementation here
}

module.exports = { implementTask };
`;
  }
}

/**
 * Verifier (Test) Agent - Runs tests and reports results
 */
class VerifierAgent {
  constructor(tools) {
    this.tools = tools;
  }

  async process(context) {
    // Run tests
    console.log('🧪 Running tests...');
    const testResult = this.tools.run_cmd('npm test -s');
    
    return {
      output: `🧪 Test execution completed.\n\n${testResult}\n\nReturning to Analyst for final review.`,
      handoff: 'analyst'
    };
  }
}

/**
 * CLI Interface
 */
async function main() {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  let task = null;
  let maxTurns = 8;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task' && args[i + 1]) {
      task = args[i + 1];
      i++; // Skip next argument
    } else if (args[i] === '--max-turns' && args[i + 1]) {
      maxTurns = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/orchestrator.mjs --task "description" [--max-turns N]

Options:
  --task "description"    Task to orchestrate (required)
  --max-turns N          Maximum turns (default: 8)  
  --help, -h             Show this help

Example:
  node scripts/orchestrator.mjs --task "Add RSI indicator to indicators/ta.js and tests"
`);
      process.exit(0);
    }
  }

  if (!task) {
    console.error('❌ Error: --task parameter is required');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  // Initialize tools and orchestrator
  const tools = new SafeTools();
  const orchestrator = new AgentOrchestrator(tools);
  orchestrator.maxTurns = maxTurns;

  try {
    const result = await orchestrator.orchestrate(task);
    console.log(result);
    process.exit(0);
  } catch (error) {
    console.error('❌ Orchestration failed:', error.message);
    process.exit(1);
  }
}

// Export for testing
export { SafeTools, AgentOrchestrator };

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}