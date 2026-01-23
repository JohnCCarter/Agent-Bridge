#!/usr/bin/env node

// Node Orchestrator (Path 2) - Manages agent interactions with adapter modules and command whitelist
// This replaces child_process usage with programmatic imports for better integration

import { runCursorAgent } from '../src/adapters/cursor-agent-adapter.mjs';
import { runCodexAgent } from '../src/adapters/codex-agent-adapter.mjs';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { SessionRecorder } from './session-recorder.mjs';
import {
  normalizeAgentExchange,
  createInitialEnvelope,
  mapHandoffToAgent,
  formatEnvelopeSummary
} from './collaboration-protocol.mjs';

const require = createRequire(import.meta.url);
const path = require('path');

// Security: Command whitelist for run_cmd functionality
const WHITELISTED_COMMANDS = new Set([
  'npm test',
  'npm test --',  // Allow npm test with flags
  'npm run test',
  'npm run build',
  'npm run lint',
  'node',  // Allow running local script files
  'git status',
  'git diff'
]);

// TODO: Make this config-driven for easier extension
const COMMAND_TIMEOUT = 120000; // 120 seconds

/**
 * Secure command execution with whitelist validation
 * @param {string} command - Command to execute
 * @param {Array} args - Command arguments
 * @returns {Promise<Object>} - { success: boolean, stdout: string, stderr: string, exitCode: number }
 */
async function runCmd(command, args = []) {
  const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  
  // Security check: validate against whitelist
  // First check for exact command match (O(1))
  let isWhitelisted = WHITELISTED_COMMANDS.has(command);
  
  // If not exact match, check for prefix matches
  if (!isWhitelisted) {
    for (const allowed of WHITELISTED_COMMANDS) {
      if (allowed !== command && allowed.startsWith(command) && fullCommand.startsWith(allowed)) {
        isWhitelisted = true;
        break;
      }
    }
  }
  
  if (!isWhitelisted) {
    const warning = `⚠️  SECURITY WARNING: Command "${fullCommand}" is not whitelisted and cannot be executed.
    
Allowed commands:
- npm test (with optional flags)  
- node <script.js> (local scripts only)
- git status
- git diff

TODO: Extend whitelist via configuration file if needed.`;
    
    console.error(warning);
    return {
      success: false,
      stdout: '',
      stderr: warning,
      exitCode: 1
    };
  }
  
  return new Promise((resolve) => {
    console.log(`Executing whitelisted command: ${fullCommand}`);
    
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (stdoutChunk) => {
      stdout += stdoutChunk.toString();
    });
    
    child.stderr.on('data', (stderrChunk) => {
      stderr += stderrChunk.toString();
    });
    
    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(), 
        exitCode: exitCode || 0
      });
    });
    
    child.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: `Command execution error: ${error.message}`,
        exitCode: 1
      });
    });
  });
}

function tokenizeCommand(commandString) {
  if (!commandString || typeof commandString !== 'string') return null;
  const tokens = commandString.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const cleaned = tokens.map(token => token.replace(/^['"](.*)['"]$/, '$1'));
  if (!cleaned.length) return null;
  const [command, ...args] = cleaned;
  return { command, args };
}

/**
 * Main orchestrator class managing agent handoffs
 */
class NodeOrchestrator {
  constructor() {
    this.currentAgent = 'analyst'; // Start with analyst
    this.turnCount = 0;
    this.maxTurns = 8; // Reasonable limit for smoke test
    this.conversationHistory = [];
    this.completedPhases = new Set(); // Track completed phases
    this.sessionEnvelope = null;
    this.recorder = new SessionRecorder();
  }
  
  /**
   * Process a task through the agent workflow
   * @param {string} task - Task description
   * @returns {Promise<Object>} - Result summary
   */
  async processTask(task) {
    console.log(`\n=== Node Orchestrator Starting ===`);
    console.log(`Task: "${task}"`);
    console.log(`Max turns: ${this.maxTurns}`);
    console.log(`=====================================\n`);

    let currentMessage = { task, context: { origin: 'cli' } };
    this.sessionEnvelope = createInitialEnvelope(task);
    this.recorder.start({ task, origin: currentMessage.context.origin, maxTurns: this.maxTurns });
    this.recorder.recordTurn({
      turn: 0,
      agent: 'orchestrator',
      role: 'system-bootstrap',
      message: currentMessage,
      envelope: this.sessionEnvelope,
      response: formatEnvelopeSummary(this.sessionEnvelope),
      executedChecks: []
    });
    let result = null;
    let success = true;
    
    while (this.turnCount < this.maxTurns) {
      this.turnCount++;
      console.log(`\n--- Turn ${this.turnCount} (${this.currentAgent}) ---`);
      
      try {
        switch (this.currentAgent) {
          case 'analyst':
            result = await this.runAnalyst(currentMessage);
            break;
          case 'implementer':
            result = await this.runImplementer(currentMessage);
            break;
          case 'verifier':
            result = await this.runVerifier(currentMessage);
            break;
          default:
            throw new Error(`Unknown agent: ${this.currentAgent}`);
        }

        const normalized = normalizeAgentExchange(result, { defaultRole: this.resolveRoleForAgent(this.currentAgent) });
        const { envelope: envelopeWithChecks, checkResults } = await this.applyEnvelopeChecks(normalized.envelope);
        const normalizedWithChecks = {
          ...normalized,
          envelope: envelopeWithChecks,
          content: formatEnvelopeSummary(envelopeWithChecks)
        };

        this.sessionEnvelope = envelopeWithChecks;

        this.conversationHistory.push({
          turn: this.turnCount,
          agent: this.currentAgent,
          role: normalized.role,
          message: currentMessage,
          response: normalizedWithChecks.content,
          envelope: envelopeWithChecks,
          executedChecks: checkResults
        });

        this.recorder.recordTurn({
          turn: this.turnCount,
          agent: this.currentAgent,
          role: normalized.role,
          message: currentMessage,
          envelope: envelopeWithChecks,
          response: normalizedWithChecks.content,
          executedChecks: checkResults
        });

        console.log(`Response (${result.role}):`, normalizedWithChecks.content);

        if (checkResults.length > 0) {
          console.log('Executed checks:');
          checkResults.forEach(({ description, command, success }) => {
            console.log(` - ${description || command}: ${success ? 'passed' : 'failed'}`);
          });
        }

        // Track completed phases
        this.completedPhases.add(this.currentAgent);

        // Determine next agent and message based on handoff markers
        const nextStep = this.determineNextStep(normalizedWithChecks.content, envelopeWithChecks);
        if (nextStep.agent === 'complete') {
          console.log('\n=== Task completed successfully ===');
          break;
        }

        this.currentAgent = nextStep.agent;
        // Preserve structured envelope for next hop
        currentMessage = nextStep.message || { task, previous: normalized.envelope };
        
        console.log(`Next: ${this.currentAgent}`);
        
      } catch (error) {
        console.error(`Error in turn ${this.turnCount}:`, error);
        success = false;
        break;
      }
    }

    return {
      success: success && this.turnCount <= this.maxTurns,
      totalTurns: this.turnCount,
      history: this.conversationHistory,
      finalAgent: this.currentAgent
    };
  }
  
  /**
   * Run the analyst (Cursor agent)
   */
  async runAnalyst(message) {
    return await runCursorAgent(this.buildAgentPayload(message), ['analysis', 'planning']);
  }
  
  /**
   * Run the implementer (Codex agent in implementation mode)
   */
  async runImplementer(message) {
    return await runCodexAgent(this.buildAgentPayload(message), ['implementation', 'coding']);
  }
  
  /**
   * Run the verifier (Codex agent in verification mode)
   */
  async runVerifier(message) {
    const payload = this.buildAgentPayload(message);
    payload.intent = 'run_tests';
    return await runCodexAgent(payload, ['testing', 'verification']);
  }

  buildAgentPayload(message) {
    if (typeof message === 'string') {
      return { task: message, context: {}, previous: this.sessionEnvelope };
    }
    return { ...(message || {}), previous: this.sessionEnvelope };
  }

  async applyEnvelopeChecks(envelope) {
    if (this.currentAgent !== 'verifier' && envelope?.phase !== 'verification') {
      return { envelope: envelope || {}, checkResults: [] };
    }

    if (!envelope || !Array.isArray(envelope.checks) || envelope.checks.length === 0) {
      return { envelope: envelope || {}, checkResults: [] };
    }

    let status = envelope.status || 'done';
    let handoff = envelope.handoff || 'complete';
    const updatedChecks = [];
    const checkResults = [];

    for (const check of envelope.checks) {
      if (!check.command) {
        updatedChecks.push(check);
        continue;
      }

      const parsed = tokenizeCommand(check.command);
      if (!parsed) {
        const failedCheck = { ...check, status: 'failed', error: 'Invalid command string' };
        updatedChecks.push(failedCheck);
        checkResults.push({
          description: check.description,
          command: check.command,
          success: false,
          stderr: 'Invalid command string'
        });
        status = 'blocked';
        handoff = handoff === 'complete' ? 'analyst' : handoff;
        continue;
      }

      const runningCheck = { ...check, status: 'running' };
      const outcome = await runCmd(parsed.command, parsed.args);
      const outcomeStatus = outcome.success ? 'passed' : 'failed';
      const completedCheck = {
        ...runningCheck,
        status: outcomeStatus,
        output: outcome.stdout,
        error: outcome.stderr
      };

      updatedChecks.push(completedCheck);
      checkResults.push({
        description: check.description,
        command: check.command,
        success: outcome.success,
        stdout: outcome.stdout,
        stderr: outcome.stderr
      });

      if (!outcome.success) {
        status = 'blocked';
        handoff = handoff === 'complete' ? 'analyst' : handoff;
      }
    }

    const nextEnvelope = { ...envelope, checks: updatedChecks, status, handoff };
    return { envelope: nextEnvelope, checkResults };
  }

  resolveRoleForAgent(agent) {
    switch (agent) {
      case 'analyst':
        return 'Cursor-analytiker';
      case 'implementer':
        return 'Codex-implementerare';
      case 'verifier':
        return 'Verifierare';
      default:
        return 'Cursor-analytiker';
    }
  }
  
  /**
   * Determine next step based on handoff markers in response
   * @param {string} content - Agent response content
   * @param {object} envelope - Structured agent envelope
   * @returns {Object} - { agent: string, message?: string }
   */
  determineNextStep(content, envelope) {
    if (envelope) {
      const mapped = mapHandoffToAgent(envelope.handoff);
      if (mapped === 'complete') {
        return { agent: 'complete' };
      }

      return { agent: mapped, message: { task: envelope.telemetry?.task || content, previous: envelope } };
    }

    const lowerContent = content.toLowerCase();
    
    // Priority 1: Completion markers (highest priority)
    if (lowerContent.includes('task completed') || lowerContent.includes('verification complete') || lowerContent.includes('status: implementation verified successfully')) {
      return { agent: 'complete' };
    }
    
    // Priority 2: Explicit handoff markers
    if (lowerContent.includes('handoff_to_codex')) {
      return { agent: 'implementer' };
    }
    
    // Priority 3: RUN_TESTS marker (but only from implementer, not verifier)
    if (lowerContent.includes('run_tests') && this.currentAgent === 'implementer') {
      return { agent: 'verifier' };
    }
    
    if (lowerContent.includes('returning to analyst') || lowerContent.includes('next iteration')) {
      return { agent: 'analyst' };
    }
    
    // Default flow: analyst -> implementer -> verifier -> complete
    switch (this.currentAgent) {
      case 'analyst':
        return { agent: 'implementer' };
      case 'implementer':
        return { agent: 'verifier' };
      case 'verifier':
        return { agent: 'complete' };
      default:
        return { agent: 'complete' };
    }
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  // Parse --task argument
  const taskIndex = args.findIndex(arg => arg === '--task');
  if (taskIndex === -1 || taskIndex + 1 >= args.length) {
    console.error('Usage: npm run orchestrate -- --task "Your task description"');
    console.error('Example: npm run orchestrate -- --task "Hello world"');
    process.exit(1);
  }
  
  const task = args[taskIndex + 1];
  
  const orchestrator = new NodeOrchestrator();

  try {
    const result = await orchestrator.processTask(task);

    const logPath = orchestrator.recorder.finalize({
      success: result.success,
      finalAgent: result.finalAgent,
      totalTurns: result.totalTurns,
      finalEnvelope: orchestrator.sessionEnvelope,
      notes: ['Session log persisted for replay and auditability']
    });

    console.log('\n=== Orchestration Summary ===');
    console.log(`Success: ${result.success}`);
    console.log(`Total turns: ${result.totalTurns}`);
    console.log(`Final agent: ${result.finalAgent}`);
    console.log(`Session record: ${logPath}`);

    if (!result.success) {
      console.error('Orchestration failed or exceeded maximum turns');
      process.exit(1);
    }
    
    console.log('Orchestration completed successfully');

  } catch (error) {
    console.error('Orchestration error:', error);
    if (error && typeof error.stack === 'string') {
      console.error(error.stack);
    }
    if (orchestrator?.recorder) {
      orchestrator.recorder.finalize({
        success: false,
        finalAgent: orchestrator.currentAgent,
        totalTurns: orchestrator.turnCount,
        finalEnvelope: orchestrator.sessionEnvelope,
        notes: ['Run aborted due to orchestration error']
      });
    }
    process.exit(1);
  }
}

// Export for testing and run if called directly
export { NodeOrchestrator, runCmd };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}