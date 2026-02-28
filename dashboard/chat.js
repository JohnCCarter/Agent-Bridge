const API_KEY = localStorage.getItem('agent-bridge-api-key') || '';
const authHeaders = (extra = {}) => ({
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
  ...extra,
});

const $messages = document.getElementById('messages');
const $status   = document.getElementById('status');
const $approval = document.getElementById('approval-bar');
const $input    = document.getElementById('input');
const $send     = document.getElementById('send');

// Track rendered message IDs to avoid duplicates
const renderedIds = new Set();

// ── Render helpers ──────────────────────────────────────────────────────

function addBubble(sender, recipient, content, ts, id) {
  if (id && renderedIds.has(id)) return;
  if (id) {
    renderedIds.add(id);
    if (renderedIds.size > 1000) {
      renderedIds.delete(renderedIds.values().next().value);
    }
  }

  const role = (sender || 'unknown').toLowerCase();
  const cls  = `from-${['user','analyst','implementer','verifier'].includes(role) ? role : 'system'}`;
  const time = ts ? new Date(ts).toLocaleTimeString() : '';
  const div  = document.createElement('div');
  div.className = `bubble ${cls}`;
  div.innerHTML = `<div class="meta">${escHtml(sender)} → ${escHtml(recipient)} &nbsp;${time}</div>${escHtml(content)}`;
  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;

  // Show approval bar when verifier hands back to user
  if (sender === 'verifier' && recipient === 'user') {
    $approval.style.display = 'flex';
  }
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'bubble from-system';
  div.textContent = text;
  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Load history ────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch('/conversation?limit=50', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.messages) {
      addBubble(m.sender, m.recipient, m.content, m.timestamp, m.id);
    }
    if (data.messages.length) addSystem('— history loaded —');
  } catch { /* bridge not ready yet */ }
}

// ── SSE for live updates ─────────────────────────────────────────────────

function connectSSE() {
  const url = API_KEY ? `/events?key=${encodeURIComponent(API_KEY)}` : '/events';
  const es  = new EventSource(url);

  es.onopen  = () => { $status.textContent = 'connected';     $status.style.color = '#16a34a'; };
  es.onerror = () => { $status.textContent = 'reconnecting…'; $status.style.color = '#f59e0b'; };

  es.addEventListener('message', e => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'message.published') {
        fetchRecent();
      }
    } catch {}
  });
}

async function fetchRecent() {
  try {
    const res = await fetch('/conversation?limit=20', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.messages) {
      addBubble(m.sender, m.recipient, m.content, m.timestamp, m.id);
    }
  } catch {}
}

// ── Send message ─────────────────────────────────────────────────────────

async function sendMessage() {
  const content = $input.value.trim();
  if (!content) return;

  $approval.style.display = 'none';
  $send.disabled = true;
  $input.value = '';

  // Parse explicit @mention or default to analyst
  const mention   = content.match(/@(analyst|implementer|verifier)/i);
  const recipient = mention ? mention[1].toLowerCase() : 'analyst';
  const body      = content.replace(/^@(analyst|implementer|verifier)\s*/i, '').trim() || content;

  try {
    await fetch('/publish_message', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ sender: 'user', recipient, content: body }),
    });
  } catch (err) {
    addSystem(`Error: ${err.message}`);
  } finally {
    $send.disabled = false;
    $input.focus();
  }
}

function approve(yes) {
  $approval.style.display = 'none';
  addSystem(yes ? '✓ Task approved by user.' : '✗ Task rejected — type what should change.');
  if (!yes) $input.focus();
}

// ── Event listeners ───────────────────────────────────────────────────────

$send.addEventListener('click', sendMessage);
document.querySelector('button.yes').addEventListener('click', () => approve(true));
document.querySelector('button.no').addEventListener('click', () => approve(false));

$input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Boot ─────────────────────────────────────────────────────────────────

loadHistory();
connectSSE();
