#!/usr/bin/env node

/**
 * Smoke test for Agent-Bridge Node Orchestrator
 * 
 * Validates that the orchestrator can complete a full loop:
 * Analyst → Implementer → Test → Analyst
 */

import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function logStep(step, message) {
  console.log(`[${step}] ${message}`);
}

function ensureCondition(condition, message) {
  if (!condition) {
    throw new Error(`Smoke test failed: ${message}`);
  }
}

async function runSmokeTest() {
  logStep('INIT', 'Starting orchestrator smoke test');
  
  const startTime = Date.now();
  
  try {
    // Run orchestrator with a simple code task to ensure implementer is triggered
    const testTask = 'Create test function for validation';
    const cmd = `node scripts/orchestrator.mjs --task "${testTask}" --max-turns 6`;
    
    logStep('EXEC', `Running: ${cmd}`);
    
    const output = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30000 // 30 seconds
    });
    
    logStep('OUTPUT', 'Orchestrator completed, analyzing output...');
    
    // Validate the output contains expected workflow steps
    ensureCondition(
      output.includes('=== Turn 1: ANALYST ==='),
      'Missing analyst turn'
    );
    
    ensureCondition(
      output.includes('=== Turn 2: IMPLEMENTER ==='),
      'Missing implementer turn'
    );
    
    ensureCondition(
      output.includes('=== Turn 3: VERIFIER ==='),
      'Missing verifier turn'
    );
    
    ensureCondition(
      output.includes('=== Turn 4: ANALYST ==='),
      'Missing final analyst turn'
    );
    
    ensureCondition(
      output.includes('Task completed by analyst'),
      'Task not properly completed'
    );
    
    ensureCondition(
      output.includes('ORCHESTRATION SUMMARY'),
      'Missing summary section'
    );
    
    // Check that handoffs occurred
    ensureCondition(
      output.includes('Handing off to: implementer'),
      'Missing handoff to implementer'
    );
    
    ensureCondition(
      output.includes('Handing off to: verifier'),
      'Missing handoff to verifier'
    );
    
    // Validate test execution occurred
    ensureCondition(
      output.includes('Running tests...') || output.includes('Test execution completed'),
      'Tests were not executed'
    );
    
    const duration = Date.now() - startTime;
    
    logStep('SUCCESS', `✅ Smoke test passed in ${duration}ms`);
    logStep('SUMMARY', 'Orchestrator completed full workflow: Analyst → Implementer → Verifier → Analyst');
    
    // Check for any generated files (optional validation)
    const possibleFiles = ['implementation.js', 'tmp/orchestrator-demo.txt'];
    const generatedFiles = possibleFiles.filter(file => 
      existsSync(join(REPO_ROOT, file))
    );
    
    if (generatedFiles.length > 0) {
      logStep('FILES', `Generated files: ${generatedFiles.join(', ')}`);
    }
    
    return true;
    
  } catch (error) {
    logStep('ERROR', `❌ Smoke test failed: ${error.message}`);
    
    if (error.stdout) {
      console.log('\n--- STDOUT ---');
      console.log(error.stdout);
    }
    
    if (error.stderr) {
      console.log('\n--- STDERR ---');
      console.log(error.stderr);
    }
    
    return false;
  }
}

// Main execution
async function main() {
  try {
    const success = await runSmokeTest();
    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error('Smoke test crashed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runSmokeTest };