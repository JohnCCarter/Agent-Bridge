// Start both autonomous agents for fully automated communication
// Run this to activate Cursor <> Codex communication without a human in the loop

const AutonomousCursorAgent = require('./autonomous-cursor-agent.js');
const AutonomousCodexAgent = require('./autonomous-codex-agent.js');

class AutonomousAgentSystem {
  constructor() {
    this.cursorAgent = new AutonomousCursorAgent();
    this.codexAgent = new AutonomousCodexAgent();
    this.isRunning = false;
  }

  // Start the full system
  async start() {
    if (this.isRunning) {
      console.log('Autonomous agents already running');
      return;
    }

    console.log('Starting Autonomous Agent System');
    console.log('================================');

    this.isRunning = true;

    // Start both agents
    console.log('\n- Starting Cursor Agent...');
    await this.cursorAgent.start();

    console.log('\n- Starting Codex Agent...');
    await this.codexAgent.start();

    console.log('\nBoth agents are running!');
    console.log('Autonomous communication enabled');
    console.log('Agents communicate automatically every 30 seconds');
    console.log('\nTips:');
    console.log('   - Cursor automatically delegates tasks to Codex');
    console.log('   - Codex analyses the tasks and replies automatically');
    console.log('   - Cursor processes the result and takes action');
    console.log('   - No manual intervention required');

    // Show status every two minutes
    this.statusInterval = setInterval(() => {
      this.showSystemStatus();
    }, 120000);

    // Add initial tasks after five seconds
    setTimeout(() => {
      this.addInitialTasks();
    }, 5000);
  }

  // Add a handful of initial tasks so the loop has work to do
  addInitialTasks() {
    console.log('\nAdding initial test tasks...');

    // Task 1: Analyse the TypeScript configuration
    this.cursorAgent.addTask('Analyse TypeScript configuration and suggest improvements', {
      files: ['tsconfig.json'],
      focus: ['type_safety', 'performance', 'best_practices'],
      priority: 'high',
      intent: 'code_analysis'
    });

    // Task 2: Security audit of the Express server
    setTimeout(() => {
      this.cursorAgent.addTask('Perform security audit of Express server', {
        files: ['src/index.ts'],
        focus: ['security', 'error_handling'],
        priority: 'high',
        intent: 'security_audit'
      });
    }, 10000);

    // Task 3: Performance analysis
    setTimeout(() => {
      this.cursorAgent.addTask('Analyse performance and provide optimisation ideas', {
        files: ['src/index.ts'],
        focus: ['performance', 'memory_usage'],
        priority: 'medium',
        intent: 'performance_optimization'
      });
    }, 20000);

    console.log('Initial tasks added');
  }

  // Display high level system status
  showSystemStatus() {
    console.log('\nAutonomous Agent System Status');
    console.log('==============================');
    console.log(`System active: ${this.isRunning}`);
    console.log(`Cursor Agent: ${this.cursorAgent.isRunning ? 'Active' : 'Inactive'}`);
    console.log(`Codex Agent: ${this.codexAgent.isRunning ? 'Active' : 'Inactive'}`);
    console.log(`Cursor queued tasks: ${this.cursorAgent.taskQueue.length}`);
    console.log(`Cursor active tasks: ${this.cursorAgent.activeTasks.size}`);
    console.log(`Cursor polling interval: ${this.cursorAgent.pollingInterval / 1000}s`);
  }

  // Stop the whole system
  async stop() {
    if (!this.isRunning) {
      console.log('System already stopped');
      return;
    }

    console.log('\nStopping Autonomous Agent System...');

    this.isRunning = false;

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }

    this.cursorAgent.stop();
    this.codexAgent.stop();

    console.log('System stopped');
  }

  // Add a custom task from the outside
  addCustomTask(description, options = {}) {
    this.cursorAgent.addTask(description, options);
    console.log(`Custom task added: ${description}`);
  }

  // Show recent activity in the Cursor agent
  showActivity() {
    console.log('\nRecent activity:');
    console.log('================');

    if (this.cursorAgent.activeTasks.size > 0) {
      console.log('Active Cursor tasks:');
      for (const [correlationId, task] of this.cursorAgent.activeTasks) {
        console.log(`   ${correlationId}: ${task.task} (${task.status})`);
      }
    } else {
      console.log('No active tasks');
    }
  }
}

// Entrypoint
async function main() {
  const system = new AutonomousAgentSystem();

  // Start the system
  await system.start();

  // Handle process signals so we shut down cleanly
  process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    await system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down...');
    await system.stop();
    process.exit(0);
  });

  // Allow custom tasks via CLI arguments
  if (process.argv.length > 2) {
    const taskDescription = process.argv.slice(2).join(' ');
    setTimeout(() => {
      system.addCustomTask(taskDescription);
    }, 10000);
  }

  // Show activity every five minutes
  setInterval(() => {
    system.showActivity();
  }, 300000);

  // Stop automatically after one hour (test safeguard)
  setTimeout(async () => {
    console.log('\nTest run finished, stopping system...');
    await system.stop();
    process.exit(0);
  }, 3600000);
}

// Run if invoked directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = AutonomousAgentSystem;
