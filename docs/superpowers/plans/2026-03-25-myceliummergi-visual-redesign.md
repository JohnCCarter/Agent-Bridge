# Myceliummergi Visual Redesign – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static list-based Myceliummergi dashboard with a living D3 force-directed network graph + animated contract pipeline, demoting detail lists to a bottom row.

**Architecture:** Three `dashboard/` files only — no backend changes. D3 v7 loaded via CDN. The existing `poll()` / SSE loop in `mycelium.js` feeds the new graph and pipeline renderers alongside the existing list renderers.

**Tech Stack:** D3.js v7 (CDN), SVG animations, CSS transitions, existing Express static file serving.

---

## File Map

| File | Change |
|---|---|
| `dashboard/mycelium.html` | Add D3 CDN; add network SVG section + pipeline section above the existing grid |
| `dashboard/mycelium.css` | Add graph, pipeline, particle, and pulse styles |
| `dashboard/mycelium.js` | Add `agents` to state + poll; add `initGraph`, `updateGraph`, `buildGraphNodes`, `buildGraphLinks`, `pulseNode`, `fireParticle`, `renderPipeline`; wire into `renderAll` and SSE handler |

---

## Task 1: HTML – Add D3 CDN and new sections

**Files:**
- Modify: `dashboard/mycelium.html`

- [ ] **Step 1: Add D3 CDN link before the closing `</body>`**

Replace the existing script tag at the bottom of `dashboard/mycelium.html`:

```html
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script type="module" src="/dashboard/mycelium.js"></script>
```

- [ ] **Step 2: Add network graph section as first child of `<main class="grid">`**

Insert before `<!-- Pulsen: Triggrar -->`:

```html
    <!-- Nätverksgraf -->
    <section class="panel panel-wide network-panel">
      <h2>🕸️ Nätverksgraf — levande ekosystem</h2>
      <svg id="network-svg" width="100%" height="350"></svg>
    </section>

    <!-- Pipeline -->
    <section class="panel panel-wide">
      <h2>⚡ Pipeline — Analyst → Implementer → Verifier</h2>
      <div class="pipeline">
        <div class="pipeline-stage">
          <div class="stage-label">🔍 Analyst</div>
          <div class="stage-cards" id="pipeline-analyst"></div>
        </div>
        <div class="pipeline-arrow">▶</div>
        <div class="pipeline-stage">
          <div class="stage-label">⚙️ Implementer</div>
          <div class="stage-cards" id="pipeline-implementer"></div>
        </div>
        <div class="pipeline-arrow">▶</div>
        <div class="pipeline-stage">
          <div class="stage-label">✅ Verifier</div>
          <div class="stage-cards" id="pipeline-verifier"></div>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: Remove the Topics panel from the grid** (it is now implicitly visible in the network graph)

Delete this block from `mycelium.html`:

```html
    <!-- Topics -->
    <section class="panel">
      <h2>📡 Topics</h2>
      <ul class="item-list" id="topic-list"><li class="empty">Laddar…</li></ul>
    </section>
```

- [ ] **Step 4: Verify HTML structure in browser**

Open `http://localhost:3000/mycelium`. You should see a blank SVG rectangle at the top, the pipeline section below it, and the existing panels below that. No JS errors in the console.

- [ ] **Step 5: Commit**

```bash
git add dashboard/mycelium.html
git commit -m "feat(dashboard): add network graph SVG + pipeline sections to HTML"
```

---

## Task 2: CSS – Graph, Pipeline, Particles

**Files:**
- Modify: `dashboard/mycelium.css`

- [ ] **Step 1: Add network graph styles** at the end of `mycelium.css`:

```css
/* ── Network graph ───────────────────────────────────────────────────────── */
.network-panel { min-height: 380px; }

#network-svg {
  display: block;
  width: 100%;
  height: 350px;
  border-radius: 0.5rem;
  background: var(--bg);
  cursor: grab;
}
#network-svg:active { cursor: grabbing; }

.graph-link {
  fill: none;
  stroke-linecap: round;
  opacity: 0.7;
}
.graph-link.trust     { stroke: #22c55e; }
.graph-link.pheromone {
  stroke: var(--spore);
  stroke-dasharray: 8 4;
  animation: march 1.2s linear infinite;
}

@keyframes march {
  to { stroke-dashoffset: -24; }
}

.graph-node {
  stroke-width: 2;
  cursor: pointer;
  transition: filter 0.2s;
}
.graph-node:hover { filter: brightness(1.3); }

.graph-label {
  fill: var(--text);
  font-size: 0.75rem;
  font-weight: 600;
  pointer-events: none;
  text-shadow: 0 1px 3px var(--bg);
}

.graph-pulse {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  opacity: 0.8;
  pointer-events: none;
}

.particle {
  fill: #fde68a;
  filter: drop-shadow(0 0 4px #fde68a);
  pointer-events: none;
}
```

- [ ] **Step 2: Add pipeline styles** at the end of `mycelium.css`:

```css
/* ── Pipeline ────────────────────────────────────────────────────────────── */
.pipeline {
  display: flex;
  align-items: flex-start;
  gap: 0;
  min-height: 120px;
}

.pipeline-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0 0.75rem;
}

.pipeline-arrow {
  color: var(--muted);
  font-size: 1.4rem;
  padding-top: 1.8rem;
  flex-shrink: 0;
}

.stage-label {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--border);
}

.stage-cards {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 60px;
}

.pipeline-card {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  transition: opacity 0.3s, transform 0.3s;
}

.pipeline-card.entering {
  opacity: 0;
  transform: translateY(-8px);
}

.pipeline-card.exit {
  opacity: 0;
  transform: translateX(20px);
}

.pc-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pc-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
```

- [ ] **Step 3: Verify styles compile** (no CSS syntax errors)

Reload `http://localhost:3000/mycelium` — the SVG area should have a dark background, pipeline should show three labelled columns. No console errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/mycelium.css
git commit -m "feat(dashboard): add graph, pipeline, particle, and pulse CSS styles"
```

---

## Task 3: JS – State + Poll extension

**Files:**
- Modify: `dashboard/mycelium.js`

- [ ] **Step 1: Add `agents` to state**

Replace the existing `const state = { ... }` block:

```js
const state = {
  triggers:     [],
  leaderboard:  [],
  pheromones:   [],
  trust:        [],
  capabilities: [],
  topics:       [],
  contracts:    [],
  agents:       [],   // ← new
  events:       [],
};
```

- [ ] **Step 2: Extend `poll()` to fetch `/agents`**

Replace the existing `poll()` function:

```js
async function poll() {
  try {
    const [triggers, leaderboard, pheromones, trust, caps, topics, contracts, agentsRes] = await Promise.all([
      fetchJSON('/triggers'),
      fetchJSON('/agents/leaderboard'),
      fetchJSON('/pheromones'),
      fetchJSON('/trust'),
      fetchJSON('/capabilities'),
      fetchJSON('/topics'),
      fetchJSON('/contracts'),
      fetchJSON('/agents'),
    ]);

    state.triggers     = triggers.triggers ?? [];
    state.leaderboard  = leaderboard.leaderboard ?? [];
    state.pheromones   = pheromones.trails ?? [];
    state.trust        = trust.edges ?? [];
    state.capabilities = caps.capabilities ?? [];
    state.topics       = topics.topics ?? [];
    state.contracts    = contracts.contracts ?? [];
    state.agents       = agentsRes.agents ?? [];

    renderAll();
  } catch (err) {
    console.warn('Poll error:', err.message);
  }
}
```

- [ ] **Step 3: Verify in browser console**

Open browser devtools → Console. After page load you should see no errors and `state.agents` should have entries (type `state.agents` in the console).

- [ ] **Step 4: Commit**

```bash
git add dashboard/mycelium.js
git commit -m "feat(dashboard): add agents to state and poll"
```

---

## Task 4: JS – D3 Network Graph

**Files:**
- Modify: `dashboard/mycelium.js`

- [ ] **Step 1: Add graph state variables** after the `const state = { ... }` block:

```js
// ── Graph state ───────────────────────────────────────────────────────────────
let graphSimulation = null;
```

- [ ] **Step 2: Add `nodeRadius` helper** after the `muted()` function:

```js
function nodeRadius(d) {
  return Math.min(48, Math.max(18, 18 + (d.score ?? 0) / 3));
}
```

- [ ] **Step 3: Add `buildGraphNodes` and `buildGraphLinks`** after `nodeRadius`:

```js
function buildGraphNodes() {
  const nodeMap = new Map();

  for (const entry of state.leaderboard) {
    nodeMap.set(entry.agentName, { id: entry.agentName, score: entry.totalScore ?? 0, online: false });
  }
  for (const agent of state.agents) {
    const n = nodeMap.get(agent.name) ?? { id: agent.name, score: 0 };
    n.online = agent.status === 'online';
    nodeMap.set(agent.name, n);
  }
  for (const e of state.trust) {
    if (!nodeMap.has(e.fromAgent)) nodeMap.set(e.fromAgent, { id: e.fromAgent, score: 0, online: false });
    if (!nodeMap.has(e.toAgent))   nodeMap.set(e.toAgent,   { id: e.toAgent,   score: 0, online: false });
  }
  for (const t of state.pheromones) {
    if (!nodeMap.has(t.sender))   nodeMap.set(t.sender,   { id: t.sender,   score: 0, online: false });
    if (!nodeMap.has(t.receiver)) nodeMap.set(t.receiver, { id: t.receiver, score: 0, online: false });
  }
  return Array.from(nodeMap.values());
}

function buildGraphLinks() {
  const links = [];
  for (const e of state.trust) {
    links.push({ source: e.fromAgent, target: e.toAgent, type: 'trust',     strength: e.score,    label: e.capability });
  }
  for (const t of state.pheromones) {
    links.push({ source: t.sender,    target: t.receiver, type: 'pheromone', strength: t.strength, label: t.capability });
  }
  return links;
}
```

- [ ] **Step 4: Add `initGraph`** after `buildGraphLinks`:

```js
function initGraph() {
  const container = document.getElementById('network-svg');
  if (!container || !window.d3) return;

  const svg = d3.select(container);
  svg.append('g').attr('class', 'links');
  svg.append('g').attr('class', 'nodes');
  svg.append('g').attr('class', 'labels');
  svg.append('g').attr('class', 'particles');

  const w = container.clientWidth || 900;
  const h = 350;

  graphSimulation = d3.forceSimulation()
    .force('link',    d3.forceLink().id(d => d.id).distance(160))
    .force('charge',  d3.forceManyBody().strength(-450))
    .force('center',  d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide(d => nodeRadius(d) + 10));

  graphSimulation.on('tick', () => {
    const s = d3.select('#network-svg');
    s.select('.links').selectAll('line')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    s.select('.nodes').selectAll('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y);
    s.select('.labels').selectAll('text')
      .attr('x', d => d.x).attr('y', d => d.y + nodeRadius(d) + 15);
  });
}
```

- [ ] **Step 5: Add `updateGraph`** after `initGraph`:

```js
function updateGraph() {
  if (!graphSimulation || !window.d3) return;

  const svg   = d3.select('#network-svg');
  const nodes = buildGraphNodes();
  const links = buildGraphLinks();

  // Preserve existing node positions
  const prev = new Map(graphSimulation.nodes().map(n => [n.id, n]));
  for (const n of nodes) {
    const p = prev.get(n.id);
    if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
  }

  // Links
  const link = svg.select('.links').selectAll('line')
    .data(links, d => `${typeof d.source === 'object' ? d.source.id : d.source}|${typeof d.target === 'object' ? d.target.id : d.target}|${d.type}`);
  link.enter().append('line').attr('class', d => `graph-link ${d.type}`)
    .merge(link).attr('stroke-width', d => Math.max(1.5, d.strength * 5));
  link.exit().remove();

  // Nodes
  const node = svg.select('.nodes').selectAll('circle')
    .data(nodes, d => d.id);
  node.enter().append('circle')
    .attr('class', 'graph-node')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) graphSimulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) graphSimulation.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .append('title').text(d => d.id);
  svg.select('.nodes').selectAll('circle')
    .attr('r',      d => nodeRadius(d))
    .attr('fill',   d => d.online ? '#4ade80' : '#4b5563')
    .attr('stroke', d => d.online ? '#86efac' : '#6b7280');
  node.exit().remove();

  // Labels
  const label = svg.select('.labels').selectAll('text').data(nodes, d => d.id);
  label.enter().append('text').attr('class', 'graph-label').attr('text-anchor', 'middle')
    .merge(label).text(d => d.id);
  label.exit().remove();

  graphSimulation.nodes(nodes);
  graphSimulation.force('link').links(links);
  graphSimulation.alpha(0.3).restart();
}
```

- [ ] **Step 6: Add `pulseNode` and `fireParticle`** after `updateGraph`:

```js
function pulseNode(agentName) {
  if (!graphSimulation || !window.d3) return;
  const n = graphSimulation.nodes().find(x => x.id === agentName);
  if (!n) return;
  const ring = d3.select('#network-svg').select('.nodes').append('circle')
    .attr('class', 'graph-pulse').attr('cx', n.x).attr('cy', n.y).attr('r', nodeRadius(n));
  ring.transition().duration(700)
    .attr('r', nodeRadius(n) + 24).style('opacity', 0)
    .on('end', () => ring.remove());
}

function fireParticle(fromId, toId) {
  if (!graphSimulation || !window.d3) return;
  const from = graphSimulation.nodes().find(x => x.id === fromId);
  const to   = graphSimulation.nodes().find(x => x.id === toId);
  if (!from || !to) return;
  const p = d3.select('#network-svg').select('.particles').append('circle')
    .attr('class', 'particle').attr('r', 5).attr('cx', from.x).attr('cy', from.y);
  p.transition().duration(900).ease(d3.easeCubicInOut)
    .attrTween('cx', () => d3.interpolateNumber(from.x, to.x))
    .attrTween('cy', () => d3.interpolateNumber(from.y, to.y))
    .on('end', () => p.remove());
}
```

- [ ] **Step 7: Call `initGraph()` and `updateGraph()` from `renderAll`**

Replace the existing `renderAll()` function:

```js
function renderAll() {
  renderTriggers();
  renderLeaderboard();
  renderPheromones();
  renderTrust();
  renderCapabilities();
  renderTopics();
  renderContracts();
  renderEvents();
  updateGraph();
  renderPipeline();

  $('trigger-total').textContent  = state.triggers.length;
  $('contract-total').textContent = state.contracts.length;
  $('agent-total').textContent    = state.leaderboard.length;
}
```

- [ ] **Step 8: Call `initGraph()` in the Boot section**

Replace the boot block at the bottom:

```js
// ── Boot ──────────────────────────────────────────────────────────────────────
initGraph();
poll();
connectSSE();
setInterval(poll, POLL_INTERVAL_MS);
```

- [ ] **Step 9: Verify in browser**

Open `http://localhost:3000/mycelium`. The SVG area should show agent nodes (green circles with names) connected by coloured lines. Purple pheromone lines should have a marching-ants animation. You can drag nodes.

- [ ] **Step 10: Commit**

```bash
git add dashboard/mycelium.js
git commit -m "feat(dashboard): D3 force-directed network graph with trust + pheromone edges"
```

---

## Task 5: JS – Pipeline Renderer

**Files:**
- Modify: `dashboard/mycelium.js`

- [ ] **Step 1: Add `renderPipeline`** after `renderEvents`:

```js
function renderPipeline() {
  const stageStatuses = {
    analyst:     ['proposed', 'accepted'],
    implementer: ['in_progress'],
    verifier:    ['review'],
  };
  const terminal = new Set(['completed', 'failed', 'cancelled']);

  for (const [stage, statuses] of Object.entries(stageStatuses)) {
    const container = document.getElementById(`pipeline-${stage}`);
    if (!container) continue;

    const stageContracts = state.contracts.filter(c => statuses.includes(c.status));
    const incomingIds    = new Set(stageContracts.map(c => c.id));

    // Remove cards that left this stage
    for (const el of [...container.querySelectorAll('.pipeline-card')]) {
      if (!incomingIds.has(el.dataset.id)) {
        el.classList.add('exit');
        setTimeout(() => el.remove(), 320);
      }
    }

    // Add new cards
    const existingIds = new Set([...container.querySelectorAll('.pipeline-card')].map(e => e.dataset.id));
    for (const c of stageContracts) {
      if (existingIds.has(c.id)) continue;
      const title  = c.title.length > 32 ? c.title.slice(0, 29) + '…' : c.title;
      const ageMs  = Date.now() - new Date(c.createdAt).getTime();
      const ageStr = ageMs < 60000 ? `${Math.round(ageMs / 1000)}s` : `${Math.round(ageMs / 60000)}m`;
      const prioCls = c.priority === 'critical' ? 'danger' : c.priority === 'high' ? 'warning' : '';
      const el = document.createElement('div');
      el.className    = 'pipeline-card entering';
      el.dataset.id   = c.id;
      el.innerHTML    = `
        <div class="pc-title">${title}</div>
        <div class="pc-meta">
          <span class="badge ${prioCls}">${c.priority}</span>
          <span class="muted">${ageStr} · ${c.initiator}</span>
        </div>`;
      container.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('entering')));
    }
  }

  // Clear terminal contracts from all stages
  for (const stage of Object.keys(stageStatuses)) {
    const container = document.getElementById(`pipeline-${stage}`);
    if (!container) continue;
    for (const el of [...container.querySelectorAll('.pipeline-card')]) {
      const c = state.contracts.find(x => x.id === el.dataset.id);
      if (c && terminal.has(c.status)) {
        el.classList.add('exit');
        setTimeout(() => el.remove(), 320);
      }
    }
  }
}
```

- [ ] **Step 2: Verify pipeline in browser**

Create a test contract via curl and watch it appear in the Analyst column:

```bash
node -e "
const http = require('http');
const body = JSON.stringify({title:'Pipeline test',initiator:'analyst',priority:'high'});
const req = http.request({hostname:'localhost',port:3000,path:'/contracts',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d.slice(0,200)));});
req.write(body); req.end();
"
```

You should see a card appear in the Analyst column within 3 seconds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/mycelium.js
git commit -m "feat(dashboard): pipeline renderer – contracts flow through Analyst→Implementer→Verifier"
```

---

## Task 6: JS – SSE-driven Pulses and Particles

**Files:**
- Modify: `dashboard/mycelium.js`

- [ ] **Step 1: Wire pulses and particles into the SSE handler**

Replace the `source.onmessage` handler inside `connectSSE()`:

```js
  source.onmessage = evt => {
    try {
      const msg = JSON.parse(evt.data);
      const entry = {
        type:      msg.type,
        timestamp: msg.timestamp,
        summary:   summarise(msg.type, msg.payload),
      };
      state.events.push(entry);
      if (state.events.length > 100) state.events.shift();

      // Live graph animations (no poll needed)
      if (msg.type === 'pheromone.reinforced' && msg.payload) {
        fireParticle(msg.payload.sender, msg.payload.receiver);
      }
      if (msg.type === 'trigger.fired' && msg.payload?.action?.sender) {
        pulseNode(msg.payload.action.sender);
      }
      if (msg.type === 'agent.connected' && msg.payload?.agent) {
        pulseNode(msg.payload.agent);
      }
      if (msg.type === 'ecosystem.feedback' && msg.payload?.agentName) {
        pulseNode(msg.payload.agentName);
        if (msg.payload.fromAgent) fireParticle(msg.payload.fromAgent, msg.payload.agentName);
      }

      // Re-poll for data updates
      const fastEvents = new Set([
        'trigger.fired', 'ecosystem.feedback', 'agent.reward',
        'agent.tier_changed', 'trust.updated', 'pheromone.reinforced',
        'contract.updated', 'topic.published', 'agent.connected',
        'agent.disconnected',
      ]);
      if (fastEvents.has(msg.type)) poll();
      else renderEvents();

    } catch { /* skip malformed */ }
  };
```

- [ ] **Step 2: Verify animations**

Fire a trigger manually and watch the network graph:

```bash
node -e "
const http = require('http');
// Get first trigger id
http.get('http://localhost:3000/triggers', r => {
  let d=''; r.on('data',c=>d+=c);
  r.on('end', () => {
    const triggers = JSON.parse(d).triggers;
    if (!triggers.length) { console.log('No triggers - create one first'); return; }
    const id = triggers[0].id;
    const req = http.request({hostname:'localhost',port:3000,path:'/triggers/'+id+'/fire',method:'POST'},r2=>{let d2='';r2.on('data',c=>d2+=c);r2.on('end',()=>console.log(d2));});
    req.end();
  });
});
"
```

You should see a pulse ring expand from the sender node on the dashboard.

- [ ] **Step 3: Run full test suite to ensure no regressions**

```bash
npm test
```

Expected: `Tests: 160 passed, 160 total` (no backend changes were made).

- [ ] **Step 4: Commit**

```bash
git add dashboard/mycelium.js
git commit -m "feat(dashboard): SSE-driven node pulses and edge particles in network graph"
```

---

## Task 7: Ecosystem Seed – Auto-firing Triggers on Startup

The triggers are in-memory and lost on server restart. Add a startup seed so the ecosystem has live activity immediately.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Find the startup section in `src/index.ts`**

```bash
grep -n "Restored.*unacknowledged\|startup" src/index.ts | head -5
```

- [ ] **Step 2: Add seed triggers after the DB restore log line**

Find the line that logs `[startup] Restored` and add seed trigger creation directly after:

```typescript
// ── Seed ecosystem triggers on startup ────────────────────────────────────────
(function seedTriggers() {
  if (triggers.size > 0) return; // already seeded (e.g. hot-reload)

  const seed: Array<{ name: string; description: string; intervalMs: number; action: TriggerAction }> = [
    {
      name: 'heartbeat',
      description: 'Ekosystemets puls – håller analyst aktiv',
      intervalMs: 10_000,
      action: { type: 'publish_message', content: 'ecosystem.heartbeat', sender: 'system', recipient: 'analyst' },
    },
    {
      name: 'implementer-ping',
      description: 'Håller implementer aktiv',
      intervalMs: 15_000,
      action: { type: 'publish_message', content: 'ecosystem.ping', sender: 'system', recipient: 'implementer' },
    },
    {
      name: 'verifier-ping',
      description: 'Håller verifier aktiv',
      intervalMs: 20_000,
      action: { type: 'publish_message', content: 'ecosystem.ping', sender: 'system', recipient: 'verifier' },
    },
  ];

  for (const s of seed) {
    const t: Trigger = {
      id: generateId(),
      name: s.name,
      type: 'interval',
      enabled: true,
      intervalMs: s.intervalMs,
      action: s.action,
      description: s.description,
      createdAt: new Date().toISOString(),
      fireCount: 0,
    };
    triggers.set(t.id, t);
  }
  console.log('[startup] Seeded 3 ecosystem triggers');
})();
```

- [ ] **Step 3: Find the `Trigger` and `TriggerAction` types to confirm field names**

```bash
grep -n "^interface Trigger\|^type TriggerAction\|^interface TriggerAction" src/index.ts | head -5
```

If the type is defined differently, adjust the seed object to match the actual interface.

- [ ] **Step 4: Restart the bridge and verify**

```bash
# Kill existing bridge process and restart
npm run dev
```

Expected log output includes: `[startup] Seeded 3 ecosystem triggers`

Then check: `node -e "const http=require('http');http.get('http://localhost:3000/triggers',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d));});"`

Expected: 3 triggers listed.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: `Tests: 160 passed, 160 total`

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: seed 3 ecosystem triggers on startup so dashboard is live immediately"
```

---

## Task 8: Final visual check

- [ ] **Step 1: Start the full stack**

Terminal 1:
```bash
npm run dev
```

Terminal 2:
```bash
npm run agents
```

- [ ] **Step 2: Open `http://localhost:3000/mycelium` and verify**

Checklist:
- [ ] Network graph shows 3 agent nodes (analyst, implementer, verifier) as green circles
- [ ] Trust edges shown as green lines between nodes
- [ ] Pheromone trails shown as purple dashed animated lines
- [ ] Pipeline shows 3 labelled columns
- [ ] Triggers panel shows 3 seeded triggers with fire counts
- [ ] Connection dot is green ("Ansluten")
- [ ] Nervström shows live events as triggers fire every 10–20s
- [ ] Nodes pulse when triggers fire
- [ ] Particles fly along edges when pheromone events arrive

- [ ] **Step 3: Commit any fixes then push**

```bash
git push -u origin claude/general-session-3pPHB
```
