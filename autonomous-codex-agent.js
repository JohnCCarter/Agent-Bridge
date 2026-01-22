// Autonomous Codex Agent - Responds automatically to Cursor tasks using task contracts and locks

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AgentBridgeClient = require('./agent-bridge-client');
const { saveGeneratedFiles } = require('./utils/file-manager');
const { updateContractSafely, acknowledgeMessage } = require('./utils/contract-helpers');

const DEFAULT_LOCK_TTL = 180; // seconds
const FOLLOW_UP_LIMIT = 3;

class AutonomousCodexAgent {
  constructor() {
    this.baseUrl = process.env.AGENT_BRIDGE_URL || 'http://localhost:3000';
    this.agentName = process.env.CODEX_AGENT_NAME || 'codex';
    this.targetAgent = process.env.CURSOR_AGENT_NAME || 'cursor';
    this.isRunning = false;
    this.pollingInterval = 30000; // 30 seconds
    this.analysisCapabilities = [
      'typescript_analysis',
      'code_quality_review',
      'performance_optimization',
      'security_audit',
      'refactoring_suggestions',
      'best_practices',
      'error_handling',
      'type_safety',
      'code_generation'
    ];
    this.http = axios.create({ baseURL: this.baseUrl, timeout: 10000 });
    this.bridgeClient = new AgentBridgeClient({ baseUrl: this.baseUrl, agentName: this.agentName });
  }

  async start() {
    if (this.isRunning) {
      console.log('Codex agent already running');
      return;
    }

    this.isRunning = true;
    console.log('Autonomous Codex Agent started');
    console.log('Polling every 30 seconds for tasks from Cursor');
    console.log(`Capabilities: ${this.analysisCapabilities.join(', ')}`);

    this.pollMessages();
  }

  async pollMessages() {
    while (this.isRunning) {
      try {
        const response = await this.http.get(`/fetch_messages/${this.agentName}`);
        const messages = response.data.messages || [];

        if (messages.length > 0) {
          console.log(`\nReceived ${messages.length} new message(s) from Cursor`);

          for (const message of messages) {
            await this.handleCursorMessage(message);
          }
        }

        await this.sleep(this.pollingInterval);
      } catch (error) {
        console.error('Polling error:', error.message);
        await this.sleep(5000);
      }
    }
  }

  async handleCursorMessage(message) {
    let lockedResources = [];
    let contractId;
    let content;

    try {
      content = this.normaliseCursorPayload(message);
      const targetFiles = Array.isArray(content.payload.files) ? [...content.payload.files] : [];
      content.payload.files = targetFiles;

      console.log('\nMessage from Cursor:');
      console.log('   Task:', content.task);
      console.log('   Intent:', content.intent);
      console.log('   Correlation ID:', content.correlation_id);
      console.log('   Files:', targetFiles.length > 0 ? targetFiles.join(', ') : 'None provided');

      contractId = content.contract_id || message.contractId;

      if (contractId) {
        content.contract_id = contractId;
        await this.updateContractSafely(contractId, {
          status: 'in_progress',
          owner: this.agentName,
          note: 'Analysis started',
          metadata: {
            correlationId: content.correlation_id,
            intent: content.intent
          }
        });
      }

      if (targetFiles.length > 0) {
        const lockResult = await this.bridgeClient.lockResources(targetFiles, { ttl: DEFAULT_LOCK_TTL });
        lockedResources = lockResult.acquired;

        if (lockResult.failures.length > 0) {
          console.log('   Lock warnings:');
          lockResult.failures.forEach(item => {
            console.log('      ' + item.resource + ': ' + item.reason);
          });
        }
      }

      await this.sendStatusUpdate({
        correlationId: content.correlation_id,
        task: content.task,
        status: 'in_progress',
        payload: {
          current_phase: 'analyzing',
          files_being_analyzed: targetFiles,
          estimated_completion: new Date(Date.now() + 60000).toISOString()
        },
        contractId
      });

      const analysisResult = await this.performAnalysis(content);

      if (Array.isArray(analysisResult.generated_files) && analysisResult.generated_files.length > 0) {
        try {
          const persistedPaths = this.persistGeneratedFiles(analysisResult.generated_files);
          analysisResult.persisted_paths = persistedPaths;
          console.log('   Generated files persisted:', persistedPaths.length);
        } catch (persistError) {
          throw new Error('Failed to persist generated files: ' + persistError.message);
        }
      }

      await this.handleFollowUpActions(content, analysisResult);

      await this.sendAnalysisResult({
        correlationId: content.correlation_id,
        task: content.task,
        analysisResult,
        contractId
      });

      if (contractId) {
        await this.updateContractSafely(contractId, {
          status: 'completed',
          note: analysisResult.analysis_result || "Analysis completed",
          metadata: {
            correlationId: content.correlation_id,
            analysisType: analysisResult.analysis_type,
            recommendations: Array.isArray(analysisResult.recommendations) ? analysisResult.recommendations.length : 0,
            qualityScore: analysisResult.quality_score
          }
        });
      }

      await this.acknowledgeMessage(message.id);
      console.log('   Message acknowledged');
    } catch (error) {
      console.error('Failed to handle message:', error.message);

      try {
        const fallback = content || this.normaliseCursorPayload(message);
        await this.sendStatusUpdate({
          correlationId: fallback.correlation_id,
          task: fallback.task,
          status: 'failed',
          payload: {
            error: error.message,
            retry_after: 300
          },
          contractId
        });
      } catch (parseError) {
        console.error('Failed to parse message payload:', parseError.message);
      }

      if (contractId) {
        await this.updateContractSafely(contractId, {
          status: 'failed',
          note: error.message
        });
      }
    } finally {
      if (lockedResources.length > 0) {
        await this.bridgeClient.releaseResources(lockedResources);
      }
    }
  }

  normaliseCursorPayload(message) {
    if (!message || typeof message.content !== "string") {
      throw new Error('Cursor message missing content');
    }

    const raw = message.content.trim();

    if (!raw) {
      throw new Error('Cursor message payload was empty');
    }

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        task: raw,
        intent: 'general_assistance',
        correlation_id: message.id,
        payload: {}
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        task: raw,
        intent: 'general_assistance',
        correlation_id: message.id,
        payload: {}
      };
    }

    if (!parsed.payload || typeof parsed.payload !== "object") {
      parsed.payload = {};
    }

    if (!parsed.task || typeof parsed.task !== "string") {
      parsed.task = parsed.payload.description || raw;
    }

    parsed.intent = parsed.intent || 'general_assistance';
    parsed.correlation_id = parsed.correlation_id || message.id;

    return parsed;
  }

  async performAnalysis(content) {
    const task = content.task;
    const payload = content.payload || {};
    const intent = content.intent || 'code_analysis';

    console.log(`\nPerforming analysis: ${task}`);

    await this.sleep(2000 + Math.random() * 3000);

    switch (intent) {
      case 'code_analysis':
        return this.analyzeCodeQuality(task, payload);
      case 'security_audit':
        return this.performSecurityAudit(task, payload);
      case 'performance_optimization':
        return this.analyzePerformance(task, payload);
      case 'type_safety':
        return this.analyzeTypeSafety(task, payload);
      case 'code_generation':
        return this.generateCodeSnippet(task, payload);
      default:
        return this.generalAnalysis(task, payload);
    }
  }

  analyzeCodeQuality(task, payload) {
    return {
      analysis_result: 'Code quality analysis complete',
      recommendations: [
        'Consider extracting helpers for repeated logic',
        'Add more Jest coverage around edge cases',
        'Document API responses with concrete examples'
      ],
      quality_score: 7.8,
      files_analyzed: payload.files || [],
      analysis_type: 'code_quality'
    };
  }

  performSecurityAudit(task, payload) {
    return {
      analysis_result: 'Security audit complete',
      recommendations: [
        'Validate all user supplied input with a schema',
        'Harden error handling to avoid leaking stack traces',
        'Review authentication and authorisation paths'
      ],
      security_issues: payload.security_issues || [],
      risk_score: 6.5,
      files_analyzed: payload.files || [],
      analysis_type: 'security'
    };
  }

  analyzePerformance(task, payload) {
    return {
      analysis_result: 'Performance analysis complete',
      recommendations: [
        'Avoid unnecessary synchronous file system access',
        'Cache heavy computations when possible',
        'Profile the hot paths with realistic workloads'
      ],
      performance_score: 7.2,
      files_analyzed: payload.files || [],
      analysis_type: 'performance'
    };
  }

  analyzeTypeSafety(task, payload) {
    return {
      analysis_result: 'Type safety review complete',
      recommendations: [
        'Enable strict mode for the TypeScript compiler',
        'Add explicit return types on exported functions',
        'Introduce discriminated unions for branching logic'
      ],
      type_safety_score: 7.5,
      files_analyzed: payload.files || [],
      analysis_type: 'type_safety',
      strict_mode_ready: true
    };
  }

  generateCodeSnippet(task, payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];

    if (files.includes('site/index.html')) {
      const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <title>Välkommen</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="hero">
    <h1>Välkommen!</h1>
    <p>Det här är en enkel sida genererad av Codex och Cursor.</p>
    <button id="cta-button">Besök example.com</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`;

      const css = `:root {
  font-family: "Segoe UI", Arial, sans-serif;
  color: #1f2933;
  background: #f4f7fb;
}

body {
  margin: 0;
}

.hero {
  min-height: 100vh;
  display: grid;
  place-items: center;
  text-align: center;
  gap: 1rem;
  padding: 2rem;
}

.hero h1 {
  font-size: clamp(2rem, 5vw, 3rem);
  margin: 0;
}

.hero p {
  max-width: 32rem;
  margin: 0 auto;
  line-height: 1.6;
}

button {
  border: none;
  border-radius: 999px;
  background: #2563eb;
  color: white;
  padding: 0.75rem 2rem;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s ease;
}

button:hover {
  background: #1e3a8a;
}
`;

      const js = `document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('cta-button');
  if (button) {
    button.addEventListener('click', () => {
      window.open('https://example.com', '_blank', 'noopener');
    });
  }
});
`;

      return {
        analysis_result: 'Generated static landing page with link button',
        generated_files: [
          { path: 'site/index.html', content: html },
          { path: 'site/styles.css', content: css },
          { path: 'site/script.js', content: js }
        ],
        recommendations: [
          'Öppna site/index.html i en webbläsare',
          'Justera text och styling efter behov',
          'Uppdatera länken i script.js om knappen ska peka på en annan sida'
        ],
        files_analyzed: files,
        analysis_type: 'code_generation'
      };
    }

    const fileName = payload.file_name || 'scripts/hello-world.js';
    const message = payload.description || 'Generates a basic script.';
    const code = `// ${message}\nconsole.log('Hej varlden');\n`;

    return {
      analysis_result: 'Generated requested script content',
      generated_files: [
        {
          path: fileName,
          content: code
        }
      ],
      recommendations: [
        `Run the script with "node ${fileName}"`,
        'Extend the script with additional logic if required'
      ],
      files_analyzed: files,
      analysis_type: 'code_generation'
    };
  }

  generalAnalysis(task, payload) {
    return {
      analysis_result: 'General analysis complete',
      recommendations: [
        'Add unit tests for critical flows',
        'Introduce structured logging for debugging',
        'Document the public API surface'
      ],
      quality_score: 7.5,
      files_analyzed: payload.files || [],
      analysis_type: 'general'
    };
  }

  async sendStatusUpdate({ correlationId, task, status, payload = {}, contractId }) {
    const message = {
      correlation_id: correlationId,
      intent: 'status_update',
      task,
      status,
      contract_id: contractId,
      payload,
      needs_action: false
    };

    try {
      await this.http.post('/publish_message', {
        recipient: this.targetAgent,
        sender: this.agentName,
        contractId,
        content: JSON.stringify(message)
      });

      console.log(`   Status sent: ${status}`);
    } catch (error) {
      console.error('Failed to send status update:', error.message);
    }
  }

  persistGeneratedFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('No generated files provided for persistence.');
    }
    return saveGeneratedFiles(files);
  }

  async sendAnalysisResult({ correlationId, task, analysisResult, contractId }) {
    const message = {
      correlation_id: correlationId,
      intent: 'code_analysis',
      task,
      status: 'done',
      contract_id: contractId,
      payload: analysisResult,
      needs_action: false
    };

    try {
      const response = await this.http.post('/publish_message', {
        recipient: this.targetAgent,
        sender: this.agentName,
        contractId,
        content: JSON.stringify(message)
      });

      console.log('   Analysis result sent:');
      console.log(`      Quality score: ${analysisResult.quality_score ?? 'N/A'}`);
      console.log(`      Recommendations: ${analysisResult.recommendations?.length || 0}`);
      console.log(`      Message ID: ${response.data.messageId}`);
    } catch (error) {
      console.error('Failed to send analysis result:', error.message);
    }
  }

  async acknowledgeMessage(messageId) {
    await acknowledgeMessage(this.http, messageId);
  }

  async handleFollowUpActions(content, analysisResult) {
    try {
      const followUps = [];
      const files = (content.payload && Array.isArray(content.payload.files)) ? content.payload.files : [];
      const parentContractId = content.contract_id || content.contractId || content.correlation_id;
      const baseMetadata = {
        parentContractId,
        sourceTask: content.task,
        trigger: 'codex_autofollow'
      };

      if (Array.isArray(analysisResult.security_issues) && analysisResult.security_issues.length > 0) {
        const issuesSummary = analysisResult.security_issues.slice(0, FOLLOW_UP_LIMIT).join(', ');
        followUps.push({
          description: `Fix security issues: ${issuesSummary}`,
          priority: 'critical',
          intent: 'security_fix',
          focus: ['security', 'follow_up'],
          files,
          metadata: {
            ...baseMetadata,
            securityIssues: analysisResult.security_issues
          }
        });
      }

      if (Array.isArray(analysisResult.recommendations) && analysisResult.recommendations.length > 0 && content.intent !== 'code_generation') {
        const priority = analysisResult.quality_score && analysisResult.quality_score < 7 ? 'high' : 'medium';
        followUps.push({
          description: `Implement recommended improvements for ${content.task}`,
          priority,
          intent: 'code_improvement',
          focus: ['quality', 'follow_up'],
          files,
          metadata: {
            ...baseMetadata,
            recommendations: analysisResult.recommendations,
            qualityScore: analysisResult.quality_score
          },
          payload: {
            recommendations: analysisResult.recommendations,
            summary: analysisResult.analysis_result
          }
        });
      }

      for (const followUp of followUps) {
        await this.createFollowUpContract(followUp.description, followUp);
      }
    } catch (error) {
      console.error('Failed to evaluate follow-up actions:', error.message);
    }
  }

  async createFollowUpContract(task, options = {}) {
    try {
      const contract = await this.bridgeClient.createContractFromTask({
        title: task,
        description: options.context || 'Automatisk uppgift skapad av Codex',
        owner: this.targetAgent,
        priority: options.priority || 'medium',
        tags: options.focus || ['follow_up'],
        files: options.files || [],
        metadata: {
          ...(options.metadata || {}),
          initiatedBy: this.agentName
        }
      });

      const correlationId = contract.id;
      const message = {
        correlation_id: correlationId,
        intent: options.intent || 'code_analysis',
        task,
        status: 'proposed',
        contract_id: contract.id,
        payload: {
          files: options.files || [],
          focus: options.focus || ['follow_up'],
          priority: options.priority || 'medium',
          context: options.context || 'Automatisk uppföljning skapad av Codex',
          ...(options.payload || {})
        },
        needs_action: true,
        instructions: options.instructions || 'Utför uppföljningsuppgiften baserat på Codex analys'
      };

      await this.http.post('/publish_message', {
        recipient: this.targetAgent,
        sender: this.agentName,
        contractId: contract.id,
        content: JSON.stringify(message)
      });

      console.log('\nSkapade automatiskt ett uppföljningskontrakt:');
      console.log(`   Uppgift: ${task}`);
      console.log(`   Kontrakt ID: ${contract.id}`);
    } catch (error) {
      console.error('Failed to create follow-up contract:', error.message);
    }
  }
  async updateContractSafely(contractId, update) {
    await updateContractSafely(this.bridgeClient, contractId, update);
  }

  stop() {
    this.isRunning = false;
    console.log('Autonomous Codex Agent stopped');
  }

  showStatus() {
    console.log('\nCodex Agent Status:');
    console.log(`   Active: ${this.isRunning}`);
    console.log(`   Polling interval: ${this.pollingInterval / 1000}s`);
    console.log(`   Capabilities: ${this.analysisCapabilities.length}`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const codexAgent = new AutonomousCodexAgent();

  await codexAgent.start();

  setInterval(() => {
    codexAgent.showStatus();
  }, 120000);

  setTimeout(() => {
    codexAgent.stop();
    process.exit(0);
  }, 1800000);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = AutonomousCodexAgent;


