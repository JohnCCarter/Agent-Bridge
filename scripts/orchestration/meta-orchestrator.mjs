/**
 * MetaOrchestrator – fristående process som:
 *
 * 1. Ansluter till Agent-Bridge som WS-agent med capability 'orchestration'
 * 2. Tar emot uppdrag via inkommande meddelanden
 * 3. Frågar Claude om en fasplan (code-analysis → code-generation → testing …)
 * 4. Driver varje fas sekventiellt:
 *    - Skapar subtask-kontrakt under ett parent-kontrakt
 *    - Routar arbetet till kapabel agent via /publish_message { capability }
 *    - Väntar på SSE contract.updated { status: 'completed' }
 *    - Skickar föregående fas-resultat som kontext till nästa fas
 * 5. Aggregerar resultat och svarar tillbaka till ursprunglig avsändare
 *
 * Startas med:  npm run meta-orchestrate
 *
 * Miljövariabler:
 *   PORT                    Bryggan (default 3000)
 *   API_KEY                 Bryggan API-nyckel (om konfigurerad)
 *   ANTHROPIC_API_KEY       Claude API-nyckel (utan: fallback stub-plan)
 *   ORCHESTRATOR_NAME       Agentnamn (default 'orchestrator')
 *   PHASE_TIMEOUT_MINUTES   Max väntetid per fas i minuter (default 10)
 */

import WebSocket from 'ws';
import { callClaude } from '../../src/adapters/claude-llm.mjs';

// ── Konfiguration ─────────────────────────────────────────────────────────────

const PORT                = process.env.PORT                   || 3000;
const BRIDGE_WS_URL       = `ws://localhost:${PORT}/ws`;
const BRIDGE_HTTP         = `http://localhost:${PORT}`;
const ORCHESTRATOR_NAME   = process.env.ORCHESTRATOR_NAME      || 'orchestrator';
const PHASE_TIMEOUT_MS    = (parseInt(process.env.PHASE_TIMEOUT_MINUTES ?? '10', 10) || 10) * 60_000;

// Vilka capabilities som kan planeras
const VALID_CAPABILITIES = new Set([
  'code-analysis',
  'code-generation',
  'code-review',
  'testing',
  'documentation',
]);

// ── Planeringsprompt ──────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `\
Du är en uppgiftsplanerare för ett multi-agent mjukvaruutvecklingssystem.
Givet en uppgiftsbeskrivning, returnera en JSON-plan med de faser som krävs.

Tillgängliga capabilities:
- code-analysis:   analysera krav, design, arkitekturgranskning
- code-generation: skriva kod, implementera funktioner
- code-review:     granska befintlig kod, föreslå förbättringar
- testing:         skriva tester, köra tester, verifiera korrekthet
- documentation:   skriva docs, README, kommentarer

Regler:
1. Returnera ENBART giltig JSON – ingen annan text
2. Ta med endast de faser som faktiskt behövs
3. Håll task-beskrivningarna korta (1–2 meningar)
4. Ordna faser logiskt: analys → implementation → test

Svarsformat:
{
  "phases": [
    { "capability": "<capability>", "task": "<specifik instruktion till agenten>" }
  ]
}`;

// ── Planering via Claude ──────────────────────────────────────────────────────

/**
 * Anropar Claude för att ta fram en fasplan.
 * Returnerar en stub-plan om ANTHROPIC_API_KEY saknas.
 *
 * @param {string} task
 * @returns {Promise<{ phases: Array<{ capability: string, task: string }> }>}
 */
async function planTask(task) {
  const raw = await callClaude(PLANNER_SYSTEM_PROMPT, task);

  // Stub-fallback (ingen API-nyckel)
  if (raw.startsWith('[STUB')) {
    console.log(`[${ORCHESTRATOR_NAME}] Stub-plan (inget ANTHROPIC_API_KEY)`);
    return {
      phases: [
        { capability: 'code-analysis',   task: `Analysera uppdraget: ${task.slice(0, 200)}` },
        { capability: 'code-generation', task: `Implementera lösning för: ${task.slice(0, 200)}` },
      ],
    };
  }

  // Extrahera JSON ur Claude-svaret (ignorerar ev. omgivande text)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Planeraren returnerade inte JSON: ${raw.slice(0, 200)}`);
  }

  let plan;
  try {
    plan = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Ogiltigt JSON från planeraren: ${e.message}`);
  }

  if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
    throw new Error('Planeraren returnerade inga faser');
  }

  // Validera varje fas
  for (const phase of plan.phases) {
    if (!phase.capability || typeof phase.capability !== 'string') {
      throw new Error(`Fas saknar capability: ${JSON.stringify(phase)}`);
    }
    if (!phase.task || typeof phase.task !== 'string') {
      throw new Error(`Fas saknar task: ${JSON.stringify(phase)}`);
    }
    if (!VALID_CAPABILITIES.has(phase.capability)) {
      // Okänd capability – varning men fortsätt; bryggan köar meddelandet
      console.warn(`[${ORCHESTRATOR_NAME}] Okänd capability i plan: "${phase.capability}"`);
    }
  }

  return plan;
}

// ── MetaOrchestrator ──────────────────────────────────────────────────────────

class MetaOrchestrator {
  /** @type {WebSocket|null} */
  #ws = null;
  #reconnectDelay = 1000;
  #stopped = false;

  /**
   * Aktiva körningar.
   * @type {Map<string, {
   *   parentId: string,
   *   requester: string,
   *   phases: Array<{capability:string, task:string, contractId:string|null, status:string, result:string|null}>,
   *   resolvePhase: Function|null,
   *   rejectPhase: Function|null
   * }>}
   */
  #activeRuns = new Map();

  /** AbortController för SSE-strömmen */
  #sseAbort = null;

  start() {
    console.log(`\n[${ORCHESTRATOR_NAME}] Startar meta-orchestrator...`);
    console.log(`[${ORCHESTRATOR_NAME}] Fas-timeout: ${PHASE_TIMEOUT_MS / 60_000} minuter`);
    this.#connectWs();
    this.#connectSse();
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
    this.#sseAbort?.abort();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  #connectWs() {
    if (this.#stopped) return;
    const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
    this.#ws = new WebSocket(BRIDGE_WS_URL, { headers });

    this.#ws.on('open', () => {
      console.log(`[${ORCHESTRATOR_NAME}] WS ansluten till bryggan`);
      this.#reconnectDelay = 1000;
      this.#send({ type: 'register', from: ORCHESTRATOR_NAME, capabilities: ['orchestration'] });
    });

    this.#ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'message') return;

      const { id, from = 'unknown', payload } = msg;
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');

      console.log(`\n[${ORCHESTRATOR_NAME}] ← ${from}: "${content.slice(0, 100)}${content.length > 100 ? '…' : ''}"`);

      // ACK direkt
      if (id) this.#send({ type: 'ack', id });

      // Starta ny körning (icke-blockerande)
      this.#runOrchestration(from, content).catch(err => {
        console.error(`[${ORCHESTRATOR_NAME}] Ej hanterat fel: ${err.message}`);
      });
    });

    this.#ws.on('close', () => {
      if (this.#stopped) return;
      console.log(`[${ORCHESTRATOR_NAME}] WS frånkopplad – återansluter om ${this.#reconnectDelay}ms`);
      setTimeout(() => this.#connectWs(), this.#reconnectDelay);
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
    });

    this.#ws.on('error', err => {
      console.error(`[${ORCHESTRATOR_NAME}] WS-fel: ${err.message}`);
    });
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  async #connectSse() {
    if (this.#stopped) return;
    try {
      this.#sseAbort = new AbortController();
      const headers = {
        Accept: 'text/event-stream',
        ...(process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {}),
      };

      const res = await fetch(`${BRIDGE_HTTP}/events`, {
        signal: this.#sseAbort.signal,
        headers,
      });

      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      console.log(`[${ORCHESTRATOR_NAME}] SSE-ström ansluten`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = 'message';

      while (!this.#stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Sista raden kan vara ofullständig – spara den
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Tom rad = slut på event; återställ typ
            currentEventType = 'message';
          } else if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            try {
              const event = JSON.parse(data);
              this.#handleSseEvent(currentEventType, event);
            } catch { /* ignorera parse-fel */ }
          }
        }
      }
    } catch (err) {
      if (this.#stopped || err.name === 'AbortError') return;
      console.warn(`[${ORCHESTRATOR_NAME}] SSE-fel: ${err.message} – återansluter om 5s`);
      setTimeout(() => this.#connectSse(), 5_000);
    }
  }

  /**
   * Tar emot parsade SSE-events och notifierar aktiva körningar.
   * Händelseformatet: { id, type, timestamp, payload: { contract, actor, note } }
   */
  #handleSseEvent(type, event) {
    if (type !== 'contract.updated') return;
    const contract = event?.payload?.contract;
    if (!contract?.id) return;

    for (const run of this.#activeRuns.values()) {
      const phase = run.phases.find(p => p.contractId === contract.id);
      if (!phase) continue;

      if (contract.status === 'completed') {
        if (phase.status === 'completed') break; // ignorera dubbletter
        phase.status = 'completed';
        // Plocka resultatet ur sista history-posten
        const lastEntry = contract.history?.at(-1);
        phase.result = lastEntry?.note ?? '(agenten lämnade inget resultat-note)';
        console.log(`[${ORCHESTRATOR_NAME}] ✓ Fas "${phase.capability}" klar`);
        run.resolvePhase?.();
        run.resolvePhase = null;
        run.rejectPhase  = null;
      } else if (contract.status === 'failed') {
        if (phase.status === 'failed') break;
        phase.status = 'failed';
        console.log(`[${ORCHESTRATOR_NAME}] ✗ Fas "${phase.capability}" misslyckades`);
        run.rejectPhase?.(new Error(`Fas "${phase.capability}" misslyckades`));
        run.resolvePhase = null;
        run.rejectPhase  = null;
      }
      break;
    }
  }

  // ── Orkestreringslogik ────────────────────────────────────────────────────

  async #runOrchestration(requester, task) {
    console.log(`\n[${ORCHESTRATOR_NAME}] Planerar: "${task.slice(0, 80)}"`);

    // 1. Skapa parent-kontrakt
    let parentRes;
    try {
      parentRes = await this.#post('/contracts', {
        title: task.slice(0, 200),
        initiator: ORCHESTRATOR_NAME,
        owner: ORCHESTRATOR_NAME,
        status: 'in_progress',
        metadata: { requester },
      });
    } catch (err) {
      console.error(`[${ORCHESTRATOR_NAME}] Kunde inte skapa parent-kontrakt: ${err.message}`);
      return;
    }
    const parentId = parentRes.contract.id;
    console.log(`[${ORCHESTRATOR_NAME}] Parent-kontrakt: ${parentId}`);

    // 2. Planera faser med Claude
    let plan;
    try {
      plan = await planTask(task);
      const phaseList = plan.phases.map(p => p.capability).join(' → ');
      console.log(`[${ORCHESTRATOR_NAME}] Plan: ${phaseList}`);
    } catch (err) {
      await this.#failRun(parentId, requester, `Planering misslyckades: ${err.message}`);
      return;
    }

    // 3. Initiera körning
    const run = {
      parentId,
      requester,
      phases: plan.phases.map(p => ({
        capability: p.capability,
        task: p.task,
        contractId: null,
        status: 'pending',
        result: null,
      })),
      resolvePhase: null,
      rejectPhase:  null,
    };
    this.#activeRuns.set(parentId, run);

    // 4. Exekvera faser sekventiellt
    let previousResult = null;
    try {
      for (let i = 0; i < run.phases.length; i++) {
        const phase = run.phases[i];
        console.log(`\n[${ORCHESTRATOR_NAME}] Fas ${i + 1}/${run.phases.length}: ${phase.capability}`);
        console.log(`  Uppgift: ${phase.task.slice(0, 120)}`);

        // 4a. Skapa subtask-kontrakt
        const subtaskRes = await this.#post(`/contracts/${parentId}/subtasks`, {
          title: `[${phase.capability}] ${phase.task.slice(0, 150)}`,
          initiator: ORCHESTRATOR_NAME,
          owner: phase.capability,
          status: 'in_progress',
          metadata: { phaseIndex: i, capability: phase.capability },
        });
        phase.contractId = subtaskRes.contract.id;

        // 4b. Bygg meddelande med kontext från föregående fas
        const messagePayload = {
          task: phase.task,
          contractId: phase.contractId,
          parentContractId: parentId,
          phaseIndex: i + 1,
          totalPhases: run.phases.length,
          ...(previousResult ? { context: `Föregående fas-resultat:\n${previousResult}` } : {}),
        };

        // 4c. Vänta på fas-completion via SSE (med timeout)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            run.resolvePhase = null;
            run.rejectPhase  = null;
            reject(new Error(
              `Fas "${phase.capability}" timeout efter ${PHASE_TIMEOUT_MS / 60_000} min`
            ));
          }, PHASE_TIMEOUT_MS);

          run.resolvePhase = () => { clearTimeout(timer); resolve(); };
          run.rejectPhase  = (e) => { clearTimeout(timer); reject(e); };

          // 4d. Publicera till capability-kön
          this.#post('/publish_message', {
            capability: phase.capability,
            content: JSON.stringify(messagePayload),
            sender: ORCHESTRATOR_NAME,
            contractId: phase.contractId,
          }).then(() => {
            console.log(`[${ORCHESTRATOR_NAME}] Publicerat till capability "${phase.capability}"`);
          }).catch(err => {
            clearTimeout(timer);
            run.resolvePhase = null;
            run.rejectPhase  = null;
            reject(new Error(`Publicering misslyckades: ${err.message}`));
          });
        });

        previousResult = phase.result;
      }

      // 5. Alla faser klara – aggregera resultat
      const summary = run.phases
        .map((p, i) => `### Fas ${i + 1} – ${p.capability}\n${p.result ?? '(inget resultat)'}`)
        .join('\n\n');

      // Markera parent som completed
      await this.#patch(`/contracts/${parentId}/status`, {
        actor: ORCHESTRATOR_NAME,
        status: 'completed',
        note: summary.slice(0, 4000),
      });

      // Svara tillbaka till avsändaren
      await this.#post('/publish_message', {
        recipient: requester,
        content: JSON.stringify({
          type: 'orchestration.complete',
          parentContractId: parentId,
          phasesCompleted: run.phases.length,
          summary,
        }),
        sender: ORCHESTRATOR_NAME,
      });

      console.log(`\n[${ORCHESTRATOR_NAME}] ✅ Klar: "${task.slice(0, 60)}"`);

    } catch (err) {
      await this.#failRun(parentId, requester, err.message);
    } finally {
      this.#activeRuns.delete(parentId);
    }
  }

  /**
   * Markerar en körning som misslyckad och meddelar avsändaren.
   */
  async #failRun(parentId, requester, reason) {
    console.error(`[${ORCHESTRATOR_NAME}] ✗ Körning misslyckades: ${reason}`);
    try {
      await this.#patch(`/contracts/${parentId}/status`, {
        actor: ORCHESTRATOR_NAME,
        status: 'failed',
        note: reason.slice(0, 4000),
      });
    } catch { /* best-effort */ }

    try {
      await this.#post('/publish_message', {
        recipient: requester,
        content: JSON.stringify({
          type: 'orchestration.failed',
          parentContractId: parentId,
          reason,
        }),
        sender: ORCHESTRATOR_NAME,
      });
    } catch { /* best-effort */ }
  }

  // ── HTTP-hjälpare ─────────────────────────────────────────────────────────

  async #post(path, body) {
    const headers = {
      'Content-Type': 'application/json',
      ...(process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {}),
    };
    const res = await fetch(`${BRIDGE_HTTP}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async #patch(path, body) {
    const headers = {
      'Content-Type': 'application/json',
      ...(process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {}),
    };
    const res = await fetch(`${BRIDGE_HTTP}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PATCH ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  #send(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const orchestrator = new MetaOrchestrator();
orchestrator.start();

const shutdown = () => {
  console.log(`\n[${ORCHESTRATOR_NAME}] Stänger ner...`);
  orchestrator.stop();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
