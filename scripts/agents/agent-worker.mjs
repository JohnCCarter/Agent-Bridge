/**
 * AgentWorker – a long-running WebSocket agent that connects to Agent-Bridge,
 * listens for incoming messages, calls Claude, and forwards the response to the
 * next agent based on the HANDOFF directive in the LLM reply.
 *
 * Usage:
 *   const worker = new AgentWorker({ name, systemPrompt, defaultHandoff });
 *   worker.start();   // connect and begin listening
 *   worker.stop();    // graceful disconnect
 */

import WebSocket from 'ws';
import { callClaude, parseHandoff } from '../../src/adapters/claude-llm.mjs';

const PORT = process.env.PORT || 3000;
const BRIDGE_WS_URL = `ws://localhost:${PORT}/ws`;

export class AgentWorker {
  #name;
  #systemPrompt;
  #defaultHandoff;
  #ws = null;
  #reconnectDelay = 1000;
  #stopped = false;

  constructor({ name, systemPrompt, defaultHandoff }) {
    this.#name = name;
    this.#systemPrompt = systemPrompt;
    this.#defaultHandoff = defaultHandoff;
  }

  get name() { return this.#name; }

  start() {
    console.log(`[${this.#name}] Starting...`);
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  #connect() {
    if (this.#stopped) return;

    const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
    this.#ws = new WebSocket(BRIDGE_WS_URL, { headers });

    this.#ws.on('open', () => {
      console.log(`[${this.#name}] Connected to bridge`);
      this.#reconnectDelay = 1000;
      this.#send({ type: 'register', from: this.#name });
    });

    this.#ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      await this.#handle(msg);
    });

    this.#ws.on('close', () => {
      if (this.#stopped) return;
      console.log(`[${this.#name}] Disconnected – reconnecting in ${this.#reconnectDelay}ms`);
      setTimeout(() => this.#connect(), this.#reconnectDelay);
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
    });

    this.#ws.on('error', (err) => {
      console.error(`[${this.#name}] WS error: ${err.message}`);
    });
  }

  async #handle(msg) {
    // Only act on inbound messages – ignore heartbeats, acks, etc.
    if (msg.type !== 'message') return;

    const { id, from = 'unknown', payload } = msg;
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');

    console.log(`[${this.#name}] ← ${from}: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`);

    // Acknowledge immediately so the bridge doesn't keep re-delivering
    if (id) this.#send({ type: 'ack', id });

    // Call Claude
    let response;
    try {
      response = await callClaude(this.#systemPrompt, content);
    } catch (err) {
      console.error(`[${this.#name}] LLM error: ${err.message}`);
      response = `Error processing message: ${err.message}`;
    }

    // Route based on HANDOFF directive or fall back to default
    const handoff = parseHandoff(response) ?? this.#defaultHandoff;
    const preview = response.slice(0, 120) + (response.length > 120 ? '…' : '');

    if (handoff === 'complete') {
      console.log(`[${this.#name}] ✓ Task complete`);
      console.log(`[${this.#name}] Final response: ${preview}`);
    } else {
      console.log(`[${this.#name}] → ${handoff}: ${preview}`);
      this.#send({ type: 'message', from: this.#name, to: handoff, payload: response });
    }
  }

  #send(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
    }
  }
}
