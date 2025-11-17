import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

class SessionRecorder {
  constructor(baseDir = path.resolve(process.cwd(), 'data', 'orchestration-history')) {
    this.baseDir = baseDir;
    this.sessionId = randomUUID();
    this.meta = {};
    this.history = [];
    this.filePath = '';
  }

  start(meta = {}) {
    this.meta = {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      ...meta
    };

    fs.mkdirSync(this.baseDir, { recursive: true });
    this.filePath = path.join(this.baseDir, `${this.sessionId}.json`);
    this.persist();
    return this.sessionId;
  }

  recordTurn(turn = {}) {
    const entry = {
      ...turn,
      timestamp: new Date().toISOString()
    };
    this.history.push(entry);
    this.persist();
  }

  finalize(result = {}) {
    this.meta.completedAt = new Date().toISOString();
    this.meta.success = result.success ?? this.meta.success ?? false;
    this.meta.finalAgent = result.finalAgent ?? this.meta.finalAgent;
    this.meta.totalTurns = result.totalTurns ?? this.history.length;
    this.meta.notes = result.notes || this.meta.notes || [];

    if (result.finalEnvelope) {
      this.meta.finalEnvelope = result.finalEnvelope;
    }

    this.persist();
    return this.filePath;
  }

  persist() {
    if (!this.filePath) return;
    const payload = {
      meta: this.meta,
      history: this.history
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }
}

export { SessionRecorder };
