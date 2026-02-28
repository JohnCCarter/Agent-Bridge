import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

class SessionRecorder {
  constructor(baseDir = path.resolve(process.cwd(), 'data', 'orchestration-history')) {
    this.baseDir = baseDir;
    this.sessionId = randomUUID();
    this.meta = {};
    this.history = [];
    this.filePath = '';
    this.persistTimer = null;
    this.persistPending = false;
    this.PERSIST_DEBOUNCE_MS = 1000; // 1 second debounce for batching
  }

  start(meta = {}) {
    this.meta = {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      ...meta
    };

    fs.mkdirSync(this.baseDir, { recursive: true });
    this.filePath = path.join(this.baseDir, `${this.sessionId}.json`);
    this.persistSync(); // Initial write is sync to ensure session is created
    return this.sessionId;
  }

  recordTurn(turn = {}) {
    const entry = {
      ...turn,
      timestamp: new Date().toISOString()
    };
    this.history.push(entry);
    this.persist(); // Async with debouncing
  }

  async finalize(result = {}) {
    this.meta.completedAt = new Date().toISOString();
    this.meta.success = result.success ?? this.meta.success ?? false;
    this.meta.finalAgent = result.finalAgent ?? this.meta.finalAgent;
    this.meta.totalTurns = result.totalTurns ?? this.history.length;
    this.meta.notes = result.notes || this.meta.notes || [];

    if (result.finalEnvelope) {
      this.meta.finalEnvelope = result.finalEnvelope;
    }

    await this.flushPersist(); // Ensure final state is written immediately
    return this.filePath;
  }

  /**
   * Async persist with debouncing to batch rapid updates.
   * Multiple recordTurn() calls within 1 second are batched into a single write.
   */
  persist() {
    if (!this.filePath) return;
    
    this.persistPending = true;
    
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    
    this.persistTimer = setTimeout(async () => {
      if (!this.persistPending) return;
      
      try {
        const payload = {
          meta: this.meta,
          history: this.history
        };
        // Use compact JSON in production for faster serialization
        await fsPromises.writeFile(this.filePath, JSON.stringify(payload), 'utf8');
        this.persistPending = false;
      } catch (error) {
        console.error('Failed to persist session:', error);
      }
    }, this.PERSIST_DEBOUNCE_MS);
  }

  /**
   * Synchronous persist for initial session creation (ensures file exists before proceeding).
   */
  persistSync() {
    if (!this.filePath) return;
    const payload = {
      meta: this.meta,
      history: this.history
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Flush pending writes immediately (for finalization or testing).
   */
  async flushPersist() {
    if (!this.filePath || !this.persistPending) return;
    
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    try {
      const payload = {
        meta: this.meta,
        history: this.history
      };
      await fsPromises.writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
      this.persistPending = false;
    } catch (error) {
      console.error('Failed to flush session persistence:', error);
      throw error;
    }
  }
}

export { SessionRecorder };
