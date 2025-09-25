// Autonomous Cursor Agent - Handles communication with Codex using task contracts, locks, and event stream updates

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AgentBridgeClient = require('./agent-bridge-client');

const CONTRACT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class AutonomousCursorAgent {
  constructor() {
    this.baseUrl = process.env.AGENT_BRIDGE_URL || 'http://localhost:3000';
    this.agentName = process.env.CURSOR_AGENT_NAME || 'cursor';
    this.targetAgent = process.env.CODEX_AGENT_NAME || 'codex';
    this.isRunning = false;
    this.pollingInterval = 30000; // 30 seconds
    this.taskQueue = [];
    this.activeTasks = new Map();
    this.contractActivity = new Map();
    this.maxActivityEntries = 20;
    this.eventSource = null;
    this.eventReconnectTimer = null;
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
    this.bridgeClient = new AgentBridgeClient({ baseUrl: this.baseUrl, agentName: this.agentName });
  }

  async start() {
    if (this.isRunning) {
      console.log('Cursor agent already running');
      return;
    }

    this.isRunning = true;
    console.log('Autonomous Cursor Agent started');
    console.log('Polling every 30 seconds for Codex replies');
    console.log('Automatic communication with Codex enabled');

    this.subscribeToEvents();
    this.pollMessages();
    this.processTaskQueue();
  }

  subscribeToEvents() {
    if (!this.isRunning) {
      return;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    console.log('Connecting to Agent-Bridge event stream...');
    this.eventSource = this.bridgeClient.subscribeEvents({
      onEvent: (event) => this.handleBridgeEvent(event),
      onError: (error) => this.handleEventStreamError(error)
    });
  }

  handleEventStreamError(error) {
    const message = error?.message || error;
    console.error('Event stream error:', message);

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (!this.eventReconnectTimer && this.isRunning) {
      this.eventReconnectTimer = setTimeout(() => {
        this.eventReconnectTimer = null;
        this.subscribeToEvents();
      }, 3000);
    }
  }

  handleBridgeEvent(event) {
    if (!event || !event.payload) {
      return;
    }

    const payload = event.payload;
    const data = payload.data;
    if (!data) {
      return;
    }

    switch (event.type) {
      case 'contract.created':
      case 'contract.updated': {
        const contract = data.contract;
        if (!contract) {
          return;
        }
        this.logContractActivity(contract.id, {
          timestamp: payload.timestamp,
          type: event.type,
          status: contract.status,
          actor: data.actor,
          note: data.note
        });
        this.setActiveTaskStatusFromContract(contract);
        break;
      }
      case 'contract.message_linked': {
        if (!data.contractId) {
          return;
        }
        this.logContractActivity(data.contractId, {
          timestamp: payload.timestamp,
          type: event.type,
          messageId: data.messageId
        });
        break;
      }
      case 'lock.created':
      case 'lock.renewed':
      case 'lock.released':
      case 'lock.expired': {
        // Optional: could add lock tracking later
        break;
      }
      default:
        break;
    }
  }

  logContractActivity(contractId, entry) {
    const history = this.contractActivity.get(contractId) || [];
    history.push(entry);
    if (history.length > this.maxActivityEntries) {
      history.shift();
    }
    this.contractActivity.set(contractId, history);
  }

  setActiveTaskStatusFromContract(contract) {
    for (const [correlationId, task] of this.activeTasks.entries()) {
      if (task.contractId === contract.id) {
        task.status = contract.status;
        if (CONTRACT_TERMINAL_STATUSES.has(contract.status)) {
          task.completedAt = new Date(contract.updatedAt || Date.now());
        }
      }
    }
  }

  async pollMessages() {
    while (this.isRunning) {
      try {
        const response = await this.http.get(`/fetch_messages/${this.agentName}`);
        const messages = response.data.messages || [];

        if (messages.length > 0) {
          console.log(`\nReceived ${messages.length} new message(s) from Codex`);

          for (const message of messages) {
            await this.handleCodexMessage(message);
          }
        }

        await this.sleep(this.pollingInterval);
      } catch (error) {
        console.error('Polling error:', error.message);
        await this.sleep(5000);
      }
    }
  }

  async handleCodexMessage(message) {
    let content;

    try {
      content = JSON.parse(message.content);
    } catch (error) {
      console.error('Failed to parse message from Codex:', error.message);
      await this.safeAcknowledge(message.id);
      return;
    }

    console.log('\nMessage from Codex:');
    console.log(`   Task: ${content.task}`);
    console.log(`   Status: ${content.status}`);
    console.log(`   Correlation ID: ${content.correlation_id}`);

    const contractId = content.contract_id || message.contractId;
    const payload = content.payload || {};
    let processingSucceeded = true;
    let completionNote = payload.analysis_result || 'Task completed';
    let resultMetadata = { persistedPaths: [] };

    try {
      if (content.status === 'done' && payload) {
        console.log(`   Result: ${payload.analysis_result || 'Completed'}`);

        if (Array.isArray(payload.recommendations) && payload.recommendations.length > 0) {
          console.log('   Recommendations:');
          payload.recommendations.forEach((rec, index) => {
            console.log(`      ${index + 1}. ${rec}`);
          });
        }

        if (payload.quality_score !== undefined) {
          console.log(`   Quality score: ${payload.quality_score}/10`);
        }

        const result = await this.processCodexResult(content);
        if (result) {
          resultMetadata = result;
          if (typeof result.note === 'string' && result.note.trim()) {
            completionNote = result.note;
          }
        }
      }
    } catch (error) {
      processingSucceeded = false;
      completionNote = `Result processing failed: ${error.message}`;
      console.error('   Failed to process Codex result:', error.message);
    }

    if (contractId && content.status === 'done') {
      await this.updateContractSafely(contractId, {
        status: processingSucceeded ? 'completed' : 'failed',
        note: completionNote,
        metadata: {
          correlationId: content.correlation_id,
          qualityScore: payload.quality_score,
          recommendations: Array.isArray(payload.recommendations) ? payload.recommendations.length : 0,
          persistedPaths: resultMetadata.persistedPaths,
          filesPersisted: Array.isArray(resultMetadata.persistedPaths) ? resultMetadata.persistedPaths.length : 0
        }
      });
    }

    await this.safeAcknowledge(message.id);
  }

  async processCodexResult(content) {
    const correlationId = content.correlation_id;
    const payload = content.payload || {};

    console.log(`\nProcessing result from Codex (${correlationId})`);

    const initialPaths = Array.isArray(payload.persisted_paths) ? payload.persisted_paths : [];
    let savedPaths = [];

    if (initialPaths.length > 0) {
      console.log(`   Codex persisted files: ${initialPaths.join(', ')}`);
    }

    if (payload.generated_files && payload.generated_files.length > 0) {
      savedPaths = this.saveGeneratedFiles(payload.generated_files);
      console.log(`   Generated files saved locally: ${savedPaths.length}`);
    }

    const persistedPaths = Array.from(new Set([...initialPaths, ...savedPaths]));

    if (Array.isArray(payload.security_issues) && payload.security_issues.length > 0) {
      console.log('   Critical security issues detected - delegating follow-up task');
      await this.delegateTask(
        `Fix security issues: ${payload.security_issues.join(', ')}`,
        {
          intent: 'security_fix',
          priority: 'critical',
          files: payload.files_analyzed,
          issues: payload.security_issues
        }
      );
    }

    if (payload.quality_score !== undefined && payload.quality_score < 7) {
      console.log(`   Low quality score (${payload.quality_score}) - requesting improvements`);
      await this.delegateTask(
        `Improve code quality based on analysis (score: ${payload.quality_score})`,
        {
          intent: 'code_improvement',
          priority: 'high',
          files: payload.files_analyzed,
          current_score: payload.quality_score,
          recommendations: payload.recommendations
        }
      );
    }

    if (Array.isArray(payload.recommended_actions) && payload.recommended_actions.length > 0) {
      for (const action of payload.recommended_actions) {
        await this.delegateTask(action.description || 'Follow up recommendation', {
          intent: action.intent || 'follow_up',
          priority: action.priority || 'medium',
          files: action.files || payload.files_analyzed,
          payload: action.payload
        });
      }
    }

    const activeTask = this.activeTasks.get(correlationId);
    if (activeTask && activeTask.contractId) {
      await this.updateContractSafely(activeTask.contractId, {
        status: 'completed',
        note: payload.analysis_result || 'Result processed',
        metadata: {
          correlationId,
          summary: payload.analysis_result,
          qualityScore: payload.quality_score,
          persistedPaths,
          filesPersisted: persistedPaths.length
        }
      });
      activeTask.status = 'completed';
      activeTask.completedAt = new Date();
    }

    return {
      persistedPaths,
      note: payload.analysis_result
    };
  }

  saveGeneratedFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return [];
    }

    const persistedPaths = [];

    for (const file of files) {
      if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
        throw new Error('Generated file entry is missing a valid path.');
      }

      if (file.content === undefined) {
        throw new Error(`Generated file ${file.path} is missing content.`);
      }

      const absolutePath = path.isAbsolute(file.path)
        ? file.path
        : path.join(process.cwd(), file.path);

      const directory = path.dirname(absolutePath);
      fs.mkdirSync(directory, { recursive: true });

      const rawContent = file.content;
      const payloadContent = Buffer.isBuffer(rawContent) ? rawContent.toString('utf8') : String(rawContent);
      let wroteFile = false;

      if (fs.existsSync(absolutePath)) {
        const existingContent = fs.readFileSync(absolutePath, 'utf8');
        if (existingContent !== payloadContent) {
          fs.writeFileSync(absolutePath, payloadContent, 'utf8');
          wroteFile = true;
        }
      } else {
        fs.writeFileSync(absolutePath, payloadContent, 'utf8');
        wroteFile = true;
      }

      const verification = fs.readFileSync(absolutePath, 'utf8');
      if (verification !== payloadContent) {
        throw new Error(`Verification failed for ${file.path}`);
      }

      const relativePath = path.relative(process.cwd(), absolutePath) || absolutePath;
      const status = wroteFile ? 'written' : 'already up-to-date';
      console.log(`   Generated file ${status}: ${relativePath}`);
      persistedPaths.push(relativePath);
    }

    return persistedPaths;
  }

  async processTaskQueue() {
    while (this.isRunning) {
      if (this.taskQueue.length > 0) {
        const task = this.taskQueue.shift();
        console.log(`\nProcessing task: ${task.description}`);

        try {
          await this.delegateTask(task.description, task.options);
        } catch (error) {
          console.error(`Failed to delegate task: ${error.message}`);
        }
      }

      await this.sleep(5000);
    }
  }

  addTask(description, options = {}) {
    this.taskQueue.push({ description, options });
    console.log(`Task queued: ${description}`);
  }

  async delegateTask(task, options = {}) {
    const correlationId = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const priority = options.priority || 'medium';
    const focus = options.focus || ['quality', 'performance', 'security'];
    const files = options.files || [];

    let contract;
    try {
      contract = await this.bridgeClient.createContractFromTask({
        title: task,
        description: options.context,
        owner: this.targetAgent,
        priority,
        tags: focus,
        files,
        metadata: {
          intent: options.intent || 'code_analysis',
          correlationId
        }
      });
      this.logContractActivity(contract.id, {
        timestamp: contract.createdAt,
        type: 'contract.created',
        status: contract.status,
        actor: this.agentName
      });
    } catch (error) {
      console.error('Failed to create contract before delegating task:', error.message);
    }

    const message = {
      correlation_id: correlationId,
      intent: options.intent || 'code_analysis',
      task,
      status: 'proposed',
      contract_id: contract?.id,
      payload: {
        files,
        focus,
        priority,
        context: options.context || 'Automated code analysis',
        ...options.payload
      },
      needs_action: true,
      instructions: options.instructions || 'Analyse the code and provide detailed recommendations'
    };

    try {
      const response = await this.http.post('/publish_message', {
        recipient: this.targetAgent,
        sender: this.agentName,
        contractId: contract?.id,
        content: JSON.stringify(message)
      });

      console.log('\nDelegated task to Codex:');
      console.log(`   Task: ${task}`);
      console.log(`   Message ID: ${response.data.messageId}`);
      console.log(`   Correlation ID: ${correlationId}`);

      this.activeTasks.set(correlationId, {
        messageId: response.data.messageId,
        task,
        timestamp: new Date(),
        status: 'delegated',
        contractId: contract?.id
      });

      return {
        success: true,
        messageId: response.data.messageId,
        correlationId,
        contractId: contract?.id
      };
    } catch (error) {
      console.error('Failed to delegate to Codex:', error.message);
      if (contract?.id) {
        await this.updateContractSafely(contract.id, {
          status: 'failed',
          note: `Delegation failed: ${error.message}`
        });
      }
      return { success: false, error: error.message };
    }
  }

  async safeAcknowledge(messageId) {
    try {
      await this.acknowledgeMessage(messageId);
      console.log('   Message acknowledged');
    } catch (error) {
      console.error('Failed to acknowledge message:', error.message);
    }
  }

  async acknowledgeMessage(messageId) {
    await this.http.post('/ack_message', {
      ids: [messageId]
    });
  }

  async analyzeFileChanges(files) {
    if (!files || files.length === 0) {
      return;
    }

    console.log(`\nAutomatic analysis triggered for files: ${files.join(', ')}`);

    for (const file of files) {
      await this.delegateTask(
        `Review ${file} for quality and security`,
        {
          files: [file],
          focus: ['quality', 'security', 'performance'],
          priority: 'medium',
          context: 'Automatic file analysis'
        }
      );
    }
  }

  async updateContractSafely(contractId, update) {
    try {
      await this.bridgeClient.updateContract(contractId, update);
      this.logContractActivity(contractId, {
        timestamp: new Date().toISOString(),
        type: 'contract.local_update',
        status: update.status,
        actor: update.actor || this.agentName,
        note: update.note
      });
    } catch (error) {
      console.error(`Failed to update contract ${contractId}:`, error.message);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    console.log('Autonomous Cursor Agent stopped');
  }

  showStatus() {
    console.log('\nCursor Agent Status:');
    console.log(`   Active: ${this.isRunning}`);
    console.log(`   Tasks queued: ${this.taskQueue.length}`);
    console.log(`   Active tasks: ${this.activeTasks.size}`);
    console.log(`   Contracts tracked: ${this.contractActivity.size}`);
    console.log(`   Polling interval: ${this.pollingInterval / 1000}s`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const cursorAgent = new AutonomousCursorAgent();

  await cursorAgent.start();

  setTimeout(() => {
    cursorAgent.addTask('Analyse TypeScript configuration', {
      files: ['tsconfig.json'],
      focus: ['type_safety', 'performance'],
      priority: 'high'
    });
  }, 2000);

  setTimeout(() => {
    cursorAgent.addTask('Audit Express server implementation', {
      files: ['src/index.ts'],
      focus: ['security', 'error_handling'],
      priority: 'medium'
    });
  }, 5000);

  setInterval(() => {
    cursorAgent.showStatus();
  }, 120000);

  setTimeout(() => {
    cursorAgent.stop();
    process.exit(0);
  }, 1800000);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = AutonomousCursorAgent;
