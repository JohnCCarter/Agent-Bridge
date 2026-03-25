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
  events:       [],   // last 100
};

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

function renderAll() {
  renderTriggers();
  renderLeaderboard();
  renderPheromones();
  renderTrust();
  renderCapabilities();
  renderTopics();
  renderContracts();
  renderEvents();

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
    const [triggers, leaderboard, pheromones, trust, caps, topics, contracts] = await Promise.all([
      fetchJSON('/triggers'),
      fetchJSON('/agents/leaderboard'),
      fetchJSON('/pheromones'),
      fetchJSON('/trust'),
      fetchJSON('/capabilities'),
      fetchJSON('/topics'),
      fetchJSON('/contracts'),
    ]);

    state.triggers     = triggers.triggers ?? [];
    state.leaderboard  = leaderboard.leaderboard ?? [];
    state.pheromones   = pheromones.trails ?? [];
    state.trust        = trust.edges ?? [];
    state.capabilities = caps.capabilities ?? [];
    state.topics       = topics.topics ?? [];
    state.contracts    = contracts.contracts ?? [];

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
poll();
connectSSE();
setInterval(poll, POLL_INTERVAL_MS);
