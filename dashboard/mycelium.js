// ── Myceliummergi Dashboard ───────────────────────────────────────────────────
// SSE for live event stream + periodic polling for state panels.

const BASE = window.BRIDGE_URL || '';
const POLL_INTERVAL_MS = 3000;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  triggers:     [],
  leaderboard:  [],
  pheromones:   [],
  trust:        [],
  capabilities: [],
  topics:       [],
  contracts:    [],
  agents:       [],   // ← new
  events:       [],   // last 100
};

// ── Graph state ───────────────────────────────────────────────────────────────
let graphSimulation = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connDot   = $('conn-dot');
const connLabel = $('conn-label');

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmt(ts) {
  if (!ts) return '–';
  try {
    return new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
  } catch { return ts; }
}

function bar(value, max = 1, width = 120) {
  const pct = Math.min(1, Math.max(0, value / max)) * 100;
  const div = document.createElement('div');
  div.className = 'bar-track';
  div.innerHTML = `<div class="bar-fill" style="width:${pct.toFixed(1)}%"></div>`;
  div.title = `${(pct).toFixed(1)}%`;
  return div;
}

function badge(text, cls = '') {
  const s = document.createElement('span');
  s.className = `badge ${cls}`.trim();
  s.textContent = text;
  return s;
}

function tierClass(tier) {
  if (!tier) return '';
  const map = { novice: '', competent: 'info', expert: 'success', rehabilitating: 'danger' };
  return map[tier] ?? '';
}

function statusClass(status) {
  if (!status) return '';
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  if (status === 'in_progress') return 'warning';
  return '';
}

function pulse(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

function setList(id, items, renderFn) {
  const ul = $(id);
  if (!ul) return;
  if (!items || items.length === 0) {
    ul.innerHTML = '<li class="empty">Ingen data</li>';
    return;
  }
  ul.innerHTML = '';
  for (const item of items) ul.append(renderFn(item));
}

function li(children, cls = '') {
  const el = document.createElement('li');
  el.className = `item ${cls}`.trim();
  if (typeof children === 'string') { el.textContent = children; }
  else if (Array.isArray(children)) { children.forEach(c => c && el.append(c)); }
  else { el.append(children); }
  return el;
}

function row(...parts) {
  const div = document.createElement('div');
  div.className = 'row';
  parts.forEach(p => { if (p) div.append(typeof p === 'string' ? Object.assign(document.createElement('span'), { textContent: p }) : p); });
  return div;
}

function muted(text) {
  const s = document.createElement('span');
  s.className = 'muted';
  s.textContent = text;
  return s;
}

function nodeRadius(d) {
  return Math.min(48, Math.max(18, 18 + (d.score ?? 0) / 3));
}

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

// ── Render functions ─────────────────────────────────────────────────────────

function renderTriggers() {
  setList('trigger-list', state.triggers, t => {
    const typeIcon = t.type === 'interval' ? '⏱' : '🔗';
    const enabledBadge = badge(t.enabled ? 'aktiv' : 'pausad', t.enabled ? 'success' : 'danger');
    const interval = t.intervalMs ? muted(`var ${(t.intervalMs / 1000).toFixed(0)}s`) : muted('webhook');
    const fired = muted(`fired: ${t.fireCount ?? 0}×  senast: ${fmt(t.lastFiredAt)}`);
    const actionBadge = badge(t.action?.type ?? '?', 'info');
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: `${typeIcon} ${t.name}` }),
        enabledBadge,
        interval,
      ),
      row(actionBadge, fired),
    ]);
  });
}

function renderLeaderboard() {
  setList('leaderboard-list', state.leaderboard, (entry, idx) => {
    const medals = ['🥇', '🥈', '🥉'];
    const medal = medals[entry.rank - 1] ?? `#${entry.rank}`;
    const tierBadge = badge(entry.skills[0]?.tier ?? 'novice', tierClass(entry.skills[0]?.tier));
    const scoreFill = bar(Math.max(0, entry.totalScore), 20);
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: `${medal} ${entry.agentName}` }),
        tierBadge,
        muted(`score: ${entry.totalScore?.toFixed?.(1) ?? entry.totalScore}`),
      ),
      scoreFill,
      muted(`Jobb: ${entry.skills[0]?.totalJobs ?? 0}  ✓${entry.skills[0]?.successCount ?? 0}  ✗${entry.skills[0]?.failureCount ?? 0}`),
    ]);
  });
}

function renderPheromones() {
  const sorted = [...state.pheromones].sort((a, b) => b.strength - a.strength);
  setList('pheromone-list', sorted, t => {
    const strengthFill = bar(t.strength, 1);
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: `${t.sender} → ${t.receiver}` }),
        badge(t.capability, 'info'),
      ),
      strengthFill,
      muted(`styrka: ${t.strength.toFixed(3)}`),
    ]);
  });
}

function renderTrust() {
  const sorted = [...state.trust].sort((a, b) => b.score - a.score);
  setList('trust-list', sorted, e => {
    const scoreFill = bar(e.score, 1);
    const scoreCls = e.score >= 0.6 ? 'success' : e.score < 0.45 ? 'danger' : 'warning';
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: `${e.fromAgent} → ${e.toAgent}` }),
        badge(e.capability, 'info'),
        badge(e.score.toFixed(3), scoreCls),
      ),
      scoreFill,
      muted(`${e.interactions} interaktioner`),
    ]);
  });
}

function renderCapabilities() {
  setList('capability-list', state.capabilities, c => {
    const onlineBadge = badge(`${c.onlineCount} online`, c.onlineCount > 0 ? 'success' : '');
    const queuedBadge = c.queued > 0 ? badge(`${c.queued} köade`, 'warning') : null;
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: c.capability }),
        onlineBadge,
        queuedBadge,
      ),
      muted(c.agents.join(', ')),
    ]);
  });
}

function renderTopics() {
  setList('topic-list', state.topics, t => {
    const capBadge = t.capability ? badge(t.capability, 'info') : null;
    const subsBadge = badge(`${t.subscriberCount ?? 0} prenumeranter`, t.subscriberCount > 0 ? 'success' : '');
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: t.name }),
        capBadge,
        subsBadge,
      ),
      t.description ? muted(t.description) : null,
    ]);
  });
}

function renderContracts() {
  const active = state.contracts
    .filter(c => !['completed', 'failed', 'cancelled'].includes(c.status))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 20);

  const all = active.length > 0 ? active : [...state.contracts]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 10);

  setList('contract-list', all, c => {
    const statusBadge = badge(c.status, statusClass(c.status));
    const prioBadge = badge(c.priority, c.priority === 'critical' ? 'danger' : c.priority === 'high' ? 'warning' : '');
    const tags = (c.tags ?? []).map(t => badge(t, 'info'));
    return li([
      row(
        Object.assign(document.createElement('strong'), { textContent: c.title }),
        statusBadge,
        prioBadge,
        ...tags,
      ),
      muted(`${c.initiator} → ${c.owner ?? 'ingen ägare'}  ·  ${fmt(c.updatedAt)}`),
    ], 'contract-item');
  });
}

function renderEvents() {
  const el = $('event-list');
  if (!el) return;
  const recent = [...state.events].reverse().slice(0, 80);
  if (recent.length === 0) { el.innerHTML = '<li class="empty">Väntar på events…</li>'; return; }
  el.innerHTML = '';
  for (const e of recent) {
    const typeSpan = Object.assign(document.createElement('span'), { className: `event-type event-${e.type.split('.')[0]}`, textContent: e.type });
    const time = muted(fmt(e.timestamp));
    const summary = e.summary ? Object.assign(document.createElement('span'), { className: 'event-summary', textContent: e.summary }) : null;
    const item = document.createElement('li');
    item.className = 'event-item';
    item.append(time, typeSpan);
    if (summary) item.append(summary);
    el.append(item);
  }
}

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

// ── Polling ───────────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

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

// ── SSE event stream ──────────────────────────────────────────────────────────
function summarise(type, payload) {
  if (!payload) return '';
  if (type === 'trigger.fired')      return `${payload.name} → ${payload.action}`;
  if (type === 'trigger.created')    return payload.name;
  if (type === 'ecosystem.feedback') return `${payload.agentName} ${payload.outcome} (${payload.capability})`;
  if (type === 'agent.reward')       return `${payload.agentName} +${payload.points}pts (${payload.reason})`;
  if (type === 'agent.tier_changed') return `${payload.agentName}: ${payload.from} → ${payload.to}`;
  if (type === 'trust.updated')      return `${payload.fromAgent} → ${payload.toAgent} (${payload.capability}): ${payload.score?.toFixed(3)}`;
  if (type === 'pheromone.reinforced') return `${payload.sender} → ${payload.receiver} (${payload.capability}): ${payload.strength?.toFixed(3)}`;
  if (type === 'topic.published')    return `${payload.topic} by ${payload.publisher} → ${payload.subscribers} subs`;
  if (type === 'contract.updated')   return `${payload.contract?.title} → ${payload.contract?.status}`;
  if (type === 'agent.connected')    return payload.agent;
  if (type === 'agent.disconnected') return payload.agent;
  return '';
}

function connectSSE() {
  if (!window.EventSource) { connLabel.textContent = 'EventSource stöds ej'; return; }

  const source = new EventSource(BASE + '/events');

  source.onopen = () => {
    connDot.classList.add('online');
    connLabel.textContent = 'Ansluten';
  };

  source.onerror = () => {
    connDot.classList.remove('online');
    connLabel.textContent = 'Avbruten, återansluter…';
  };

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

      // Trigger immediate re-poll on impactful events so panels update fast
      const fastEvents = new Set([
        'trigger.fired', 'ecosystem.feedback', 'agent.reward',
        'agent.tier_changed', 'trust.updated', 'pheromone.reinforced',
        'contract.updated', 'topic.published', 'agent.connected',
      ]);
      if (fastEvents.has(msg.type)) poll();
      else renderEvents();

    } catch { /* skip malformed */ }
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initGraph();
poll();
connectSSE();
setInterval(poll, POLL_INTERVAL_MS);
