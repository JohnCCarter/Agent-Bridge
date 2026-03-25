/**
 * AgentWorker – a long-running WebSocket agent that connects to Agent-Bridge,
 * listens for incoming messages, calls Claude with optional tools, and forwards
 * the response to the next agent based on the @mention in the reply.
 */

import WebSocket from 'ws';
import { callClaude, parseMention } from '../../src/adapters/claude-llm.mjs';

const PORT = process.env.PORT || 3000;
const BRIDGE_WS_URL = `ws://localhost:${PORT}/ws`;
const BRIDGE_HTTP = `http://localhost:${PORT}`;
const MAX_TURNS = 10;
const KNOWN_AGENTS = ['analyst', 'implementer', 'verifier', 'user'];

export class AgentWorker {
  #name;
  #systemPrompt;
  #defaultHandoff;
  #toolDefs;
  #toolImpls;
  #ws = null;
  #reconnectDelay = 1000;
  #stopped = false;
  #turnCount = 0;
  #processing = false;
  #capabilities = [];

  constructor({ name, systemPrompt, defaultHandoff, tools = [], capabilities = [] }) {
    this.#name = name;
    this.#systemPrompt = systemPrompt;
    this.#defaultHandoff = defaultHandoff;
    this.#toolDefs  = tools.map(t => t.def);
    this.#toolImpls = Object.fromEntries(tools.map(t => [t.def.name, t.impl]));
    this.#capabilities = capabilities;
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
      this.#turnCount = 0;
      this.#send({ type: 'register', from: this.#name, capabilities: this.#capabilities });
    });

    this.#ws.on('message', async (raw) => {
      if (this.#processing) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.#processing = true;
      try { await this.#handle(msg); } finally { this.#processing = false; }
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
    if (msg.type !== 'message') return;

    const { id, from = 'unknown', payload } = msg;
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');

    console.log(`[${this.#name}] ← ${from}: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`);

    if (id) this.#send({ type: 'ack', id });

    // Loop protection
    this.#turnCount++;
    if (this.#turnCount > MAX_TURNS) {
      console.log(`[${this.#name}] ⚠ Max turns reached – returning control to user`);
      this.#send({ type: 'message', from: this.#name, to: 'user', payload: '⚠ Max turns reached. Please review and continue.' });
      this.#turnCount = 0;
      return;
    }

    // Build context from conversation history
    const history = await this.#fetchHistory(20);
    const toolNote = this.#toolDefs.length > 0
      ? `\nYou have access to tools: ${this.#toolDefs.map(t => t.name).join(', ')}. Use them to read files and understand the project before responding.`
      : '';
    const contextualPrompt = history
      ? `${this.#systemPrompt}${toolNote}\n\n--- Conversation so far ---\n${history}\n--- End of conversation ---\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`
      : `${this.#systemPrompt}${toolNote}\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`;

    let response;
    try {
      response = await callClaude(contextualPrompt, content, this.#toolDefs, this.#toolImpls);
    } catch (err) {
      console.error(`[${this.#name}] LLM error: ${err.message}`);
      response = `Error processing message: ${err.message} @user`;
    }

    // Parse @mention for routing; fall back to user if none found or self-mention
    const rawMention = parseMention(response);
    const next = (rawMention && rawMention !== this.#name && KNOWN_AGENTS.includes(rawMention))
      ? rawMention
      : 'user';

    const preview = response.slice(0, 120) + (response.length > 120 ? '…' : '');

    if (next === 'user') {
      this.#turnCount = 0;
      console.log(`[${this.#name}] → user: ${preview}`);
    } else {
      console.log(`[${this.#name}] → ${next}: ${preview}`);
    }

    this.#send({ type: 'message', from: this.#name, to: next, payload: response });
  }

  #send(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
    }
  }

  async #fetchHistory(limit = 20) {
    try {
      const fetchHeaders = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
      const res = await fetch(`${BRIDGE_HTTP}/conversation?limit=${limit}`, { headers: fetchHeaders });
      if (!res.ok) return '';
      const data = await res.json();
      if (!Array.isArray(data.messages)) return '';
      return data.messages
        .map(m => `[${m.sender}] ${m.content}`)
        .join('\n');
    } catch {
      return '';
    }
  }
}
