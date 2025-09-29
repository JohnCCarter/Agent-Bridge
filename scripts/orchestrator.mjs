#!/usr/bin/env node

// Node Orchestrator (Path 2) - Manages agent interactions with adapter modules and command whitelist
// This replaces child_process usage with programmatic imports for better integration

import { runCursorAgent } from '../src/adapters/cursor-agent-adapter.mjs';
import { runCodexAgent } from '../src/adapters/codex-agent-adapter.mjs';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const path = require('path');

// Security: Command whitelist for run_cmd functionality
const WHITELISTED_COMMANDS = new Set([
  'npm test',
  'npm test --',  // Allow npm test with flags
  'npm run test',
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
  const isWhitelisted = Array.from(WHITELISTED_COMMANDS).some(allowed => {
    if (allowed === command) return true;
    if (allowed.startsWith(command) && fullCommand.startsWith(allowed)) return true;
    return false;
  });
  
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
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
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
    
    let currentMessage = task;
    let result = null;
    
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
        
        this.conversationHistory.push({
          turn: this.turnCount,
          agent: this.currentAgent,
          role: result.role,
          message: currentMessage,
          response: result.content
        });
        
        console.log(`Response (${result.role}):`, result.content);
        
        // Track completed phases
        this.completedPhases.add(this.currentAgent);
        
        // Determine next agent and message based on handoff markers
        const nextStep = this.determineNextStep(result.content);
        if (nextStep.agent === 'complete') {
          console.log('\n=== Task completed successfully ===');
          break;
        }
        
        this.currentAgent = nextStep.agent;
        // Use original task for context, not full conversation history
        currentMessage = nextStep.message || task;
        
        console.log(`Next: ${this.currentAgent}`);
        
      } catch (error) {
        console.error(`Error in turn ${this.turnCount}:`, error);
        break;
      }
    }
    
    return {
      success: this.turnCount <= this.maxTurns,
      totalTurns: this.turnCount,
      history: this.conversationHistory,
      finalAgent: this.currentAgent
    };
  }
  
  /**
   * Run the analyst (Cursor agent)
   */
  async runAnalyst(message) {
    return await runCursorAgent(message, ['analysis', 'planning']);
  }
  
  /**
   * Run the implementer (Codex agent in implementation mode)
   */
  async runImplementer(message) {
    return await runCodexAgent(message, ['implementation', 'coding']);
  }
  
  /**
   * Run the verifier (Codex agent in verification mode)
   */
  async runVerifier(message) {
    // Add explicit verification context to trigger verification mode
    const verificationMessage = `RUN_TESTS: ${message}`;
    return await runCodexAgent(verificationMessage, ['testing', 'verification']);
  }
  
  /**
   * Determine next step based on handoff markers in response
   * @param {string} content - Agent response content
   * @returns {Object} - { agent: string, message?: string }
   */
  determineNextStep(content) {
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
  
  try {
    const orchestrator = new NodeOrchestrator();
    const result = await orchestrator.processTask(task);
    
    console.log('\n=== Orchestration Summary ===');
    console.log(`Success: ${result.success}`);
    console.log(`Total turns: ${result.totalTurns}`);
    console.log(`Final agent: ${result.finalAgent}`);
    
    if (!result.success) {
      console.error('Orchestration failed or exceeded maximum turns');
      process.exit(1);
    }
    
    console.log('Orchestration completed successfully');
    
  } catch (error) {
    console.error('Orchestration error:', error);
    process.exit(1);
  }
}

// Export for testing and run if called directly
export { NodeOrchestrator, runCmd };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}