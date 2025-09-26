#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatLogPart(part) {
  if (typeof part === 'string') {
    return part;
  }

  if (part instanceof Error) {
    return part.stack || part.message;
  }

  if (part === undefined) {
    return 'undefined';
  }

  if (part === null) {
    return 'null';
  }

  return JSON.stringify(part);
}

function captureConsole() {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    const line = args.map(formatLogPart).join(' ');
    stdout.push(line);
    originalLog(...args);
  };

  console.error = (...args) => {
    const line = args.map(formatLogPart).join(' ');
    stderr.push(line);
    originalError(...args);
  };

  return {
    stdout,
    stderr,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

function normalizePaths(paths) {
  return Array.from(new Set((paths || []).map((p) => path.normalize(p))));
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadApp() {
  const srcEntry = path.join(__dirname, '..', 'src', 'index.ts');
  if (fs.existsSync(srcEntry)) {
    let tsNodeLoaded = false;
    try {
      require('ts-node').register({ transpileOnly: true });
      tsNodeLoaded = true;
    } catch (err) {
      if (!(err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('ts-node'))) {
        throw err;
      }
    }

    if (tsNodeLoaded) {
      const moduleExports = require(srcEntry);
      return moduleExports.default || moduleExports;
    }
  }

  const distEntry = path.join(__dirname, '..', 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    throw new Error('Unable to load Agent-Bridge server. Run `npm run build` to generate dist/index.js or install ts-node.');
  }
  const moduleExports = require(distEntry);
  return moduleExports.default || moduleExports;
}

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address.port !== 'number') {
        reject(new Error('Failed to acquire random port for Agent-Bridge server.'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function fetchMessages(agent, agentName) {
  const response = await agent.http.get(`/fetch_messages/${agentName}`);
  const messages = response.data && Array.isArray(response.data.messages) ? response.data.messages : [];
  return messages;
}

async function drainCodexQueue(agent, options = {}) {
  const { attempts = 20, delay = 250 } = options;
  const processed = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messages = await fetchMessages(agent, agent.agentName);
    if (messages.length === 0) {
      if (processed.length > 0) {
        break;
      }
      await sleep(delay);
      continue;
    }

    for (const message of messages) {
      await agent.handleCursorMessage(message);
      processed.push(message);
    }
  }

  ensure(processed.length > 0, 'Codex agent did not receive any tasks to process.');
  return processed;
}

async function drainCursorQueue(agent, options = {}) {
  const { attempts = 40, delay = 250 } = options;
  const handled = [];
  let finalPayload = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const messages = await fetchMessages(agent, agent.agentName);
    if (messages.length === 0) {
      if (finalPayload) {
        break;
      }
      await sleep(delay);
      continue;
    }

    for (const message of messages) {
      let parsedContent = null;
      try {
        parsedContent = JSON.parse(message.content);
      } catch (err) {
        parsedContent = null;
      }

      if (parsedContent && parsedContent.status === 'done') {
        finalPayload = parsedContent;
      }

      await agent.handleCodexMessage(message);
      handled.push({ message, parsed: parsedContent });
    }
  }

  ensure(finalPayload, 'Cursor agent did not receive a completion message from Codex.');
  return { handled, finalPayload };
}

function backupContractsFile() {
  const contractsPath = path.join(__dirname, '..', 'data', 'contracts.json');
  if (fs.existsSync(contractsPath)) {
    return { path: contractsPath, content: fs.readFileSync(contractsPath, 'utf8') };
  }
  return { path: contractsPath, content: null };
}

function restoreContractsFile(backup) {
  if (!backup) {
    return;
  }

  if (backup.content === null) {
    if (fs.existsSync(backup.path)) {
      fs.unlinkSync(backup.path);
    }
    return;
  }

  fs.mkdirSync(path.dirname(backup.path), { recursive: true });
  fs.writeFileSync(backup.path, backup.content, 'utf8');
}

function snapshotEnv(keys) {
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  if (!snapshot) {
    return;
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function main() {
  const contractsBackup = backupContractsFile();
  let server;
  let envSnapshot;
  let cursorAgent;
  let codexAgent;
  let consoleCapture;

  try {
    const app = loadApp();
    const { server: startedServer, port } = await startServer(app);
    server = startedServer;

    const baseUrl = `http://127.0.0.1:${port}`;
    const runId = `smoke-${Date.now()}`;
    const cursorName = `${runId}-cursor`;
    const codexName = `${runId}-codex`;

    envSnapshot = snapshotEnv(['AGENT_BRIDGE_URL', 'CURSOR_AGENT_NAME', 'CODEX_AGENT_NAME']);
    process.env.AGENT_BRIDGE_URL = baseUrl;
    process.env.CURSOR_AGENT_NAME = cursorName;
    process.env.CODEX_AGENT_NAME = codexName;

    const AutonomousCursorAgent = require('../autonomous-cursor-agent.js');
    const AutonomousCodexAgent = require('../autonomous-codex-agent.js');

    cursorAgent = new AutonomousCursorAgent();
    codexAgent = new AutonomousCodexAgent();

    consoleCapture = captureConsole();

    const delegateResult = await cursorAgent.delegateTask('Generate landing page assets (smoke test)', {
      intent: 'code_generation',
      priority: 'high',
      files: ['site/index.html'],
      focus: ['code_generation', 'static_site'],
      context: 'Contract smoke test scenario for integration coverage',
      payload: {
        description: 'Create HTML, CSS, and JS assets for the demo landing page.',
        file_name: 'site/index.html'
      }
    });

    ensure(delegateResult && delegateResult.success, `Cursor failed to delegate task: ${delegateResult && delegateResult.error}`);
    const { contractId, correlationId } = delegateResult;
    ensure(contractId, 'Expected contract ID from cursor delegation.');
    ensure(correlationId, 'Expected correlation ID from cursor delegation.');

    await drainCodexQueue(codexAgent);
    const { finalPayload } = await drainCursorQueue(cursorAgent);

    ensure(finalPayload.status === 'done', `Expected final status "done" from Codex, received "${finalPayload.status}"`);
    ensure(finalPayload.contract_id === contractId, 'Final message does not reference the expected contract.');
    const analysisPayload = finalPayload.payload || {};
    ensure(analysisPayload.analysis_type === 'code_generation', 'Expected code generation analysis type from Codex.');

    const persistedPaths = normalizePaths(analysisPayload.persisted_paths || []);
    const expectedPaths = normalizePaths(['site/index.html', 'site/styles.css', 'site/script.js']);

    for (const expectedPath of expectedPaths) {
      ensure(persistedPaths.includes(expectedPath), `Persisted paths missing ${expectedPath}`);
      const absolutePath = path.join(process.cwd(), expectedPath);
      ensure(fs.existsSync(absolutePath), `Expected generated file to exist at ${expectedPath}`);
    }

    ensure(Array.isArray(analysisPayload.generated_files) && analysisPayload.generated_files.length === 3, 'Expected three generated files in analysis payload.');

    const contract = await cursorAgent.bridgeClient.fetchContract(contractId);
    ensure(contract.status === 'completed', `Contract status should be "completed" but was "${contract.status}"`);

    const metadataPersisted = normalizePaths((contract.metadata && (contract.metadata.persistedPaths || contract.metadata.persisted_paths)) || []);
    for (const expectedPath of expectedPaths) {
      ensure(metadataPersisted.includes(expectedPath), `Contract metadata missing persisted path ${expectedPath}`);
    }

    const lastHistoryEntry = Array.isArray(contract.history) ? contract.history[contract.history.length - 1] : null;
    ensure(lastHistoryEntry && lastHistoryEntry.status === 'completed', 'Contract history does not include a completion entry.');

    const capturedLogText = consoleCapture.stdout.join('\n');
    ensure(capturedLogText.includes('Generated files persisted'), 'Codex log did not mention persisted files.');
    ensure(capturedLogText.includes('Generated files saved locally'), 'Cursor log did not mention saved generated files.');

    console.log('\nContract smoke test passed.');
    console.log(`Agent bridge URL: ${baseUrl}`);
    console.log(`Contract ID: ${contractId}`);
    console.log(`Correlation ID: ${correlationId}`);
    console.log(`Persisted paths: ${persistedPaths.join(', ')}`);
  } finally {
    if (consoleCapture) {
      consoleCapture.restore();
    }
    if (codexAgent && typeof codexAgent.stop === 'function') {
      codexAgent.stop();
    }
    if (cursorAgent && typeof cursorAgent.stop === 'function') {
      cursorAgent.stop();
    }
    if (server) {
      try {
        await closeServer(server);
      } catch (err) {
        console.error('Failed to close Agent-Bridge server:', err);
      }
    }
    if (envSnapshot) {
      restoreEnv(envSnapshot);
    }
    restoreContractsFile(contractsBackup);
  }
}

main().catch((error) => {
  console.error('Contract smoke test failed:', error);
  process.exit(1);
});
