# Conversational Multi-Agent Chat — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the linear agent pipeline with a conversational @mention model where user and agents chat in real time via a web UI at `localhost:3000/chat`.

**Architecture:** Add a `GET /conversation` endpoint that returns ordered message history. Update `AgentWorker` to include that history as Claude context and parse `@mention` for routing. Add `dashboard/chat.html` that subscribes to SSE and lets the user send messages.

**Tech Stack:** Node.js, TypeScript, Jest, supertest, ES Modules, plain HTML/JS (no framework), SSE, WebSocket

---

## Task 1: Branch setup

**Files:** none

**Step 1: Create branch**

```bash
git fetch origin main
git checkout -b feat/conversational-agents origin/main
```

**Step 2: Verify clean state**

```bash
git status
npm test
```

Expected: working tree clean, 47 tests pass.

---

## Task 2: Add `GET /conversation` endpoint

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

**Step 1: Write the failing test**

Find the block in `src/index.test.ts` that tests `/fetch_messages`. Add this test after it:

```ts
describe('GET /conversation', () => {
  it('returns empty array when no messages exist', async () => {
    const res = await request(app).get('/conversation');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages).toEqual([]);
  });

  it('returns messages in publish order', async () => {
    await request(app).post('/publish_message')
      .send({ sender: 'user', recipient: 'analyst', content: 'hello' });
    await request(app).post('/publish_message')
      .send({ sender: 'analyst', recipient: 'implementer', content: 'world' });

    const res = await request(app).get('/conversation');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].sender).toBe('user');
    expect(res.body.messages[1].sender).toBe('analyst');
  });

  it('respects ?limit param', async () => {
    // publish 5 messages
    for (let i = 0; i < 5; i++) {
      await request(app).post('/publish_message')
        .send({ sender: 'user', recipient: 'analyst', content: `msg${i}` });
    }
    const res = await request(app).get('/conversation?limit=3');
    expect(res.body.messages.length).toBeLessThanOrEqual(3);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern="index.test" --testNamePattern="GET /conversation"
```

Expected: FAIL — `Cannot GET /conversation`

**Step 3: Add `conversationHistory` store to `src/index.ts`**

After line 319 (after the existing store declarations):

```ts
// Ordered log of every published message for the /conversation endpoint
const conversationHistory: Message[] = [];
```

**Step 4: Push to history in `queueMessage` function**

Find the `queueMessage` function (around line 464). After `messagesById.set(message.id, message)`, add:

```ts
conversationHistory.push(message);
```

**Step 5: Add `GET /conversation` route and middleware**

After the `app.use('/events', requireApiKey)` line (~line 250), add:
```ts
app.use('/conversation', requireApiKey);
app.use('/conversation', apiLimiter);
```

After the `GET /health` route (~line 909), add the new route:

```ts
app.get('/conversation', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const messages = conversationHistory.slice(-limit).map(m => ({
    id: m.id,
    sender: m.sender ?? 'unknown',
    recipient: m.recipient,
    content: m.content,
    timestamp: m.timestamp,
  }));
  res.json({ success: true, messages });
});
```

**Step 6: Run tests**

```bash
npm test -- --testPathPattern="index.test" --testNamePattern="GET /conversation"
```

Expected: 3 tests pass.

**Step 7: Run full suite**

```bash
npm test
```

Expected: all tests pass (47 + 3 = 50).

**Step 8: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add GET /conversation endpoint with ordered message history"
```

---

## Task 3: Add `parseMention` to `claude-llm.mjs`

**Files:**
- Modify: `src/adapters/claude-llm.mjs`

**Step 1: Add the function**

At the end of `src/adapters/claude-llm.mjs`, append:

```js
/**
 * Extract the first @mention of a known agent or user from LLM output.
 * Returns one of: 'analyst' | 'implementer' | 'verifier' | 'user' | null
 */
export function parseMention(text) {
  const match = text.match(/@(analyst|implementer|verifier|user)\b/i);
  return match ? match[1].toLowerCase() : null;
}
```

**Step 2: Verify lint passes**

```bash
npm run lint
```

Expected: 0 errors.

**Step 3: Commit**

```bash
git add src/adapters/claude-llm.mjs
git commit -m "feat: add parseMention helper to claude-llm adapter"
```

---

## Task 4: Update `AgentWorker` — history context + @mention routing

**Files:**
- Modify: `scripts/agents/agent-worker.mjs`

**Step 1: Update the import line (line 13)**

```js
import { callClaude, parseMention } from '../../src/adapters/claude-llm.mjs';
```

**Step 2: Add `#turnCount` field and constants to the class**

After `#stopped = false;` (line 24), add:

```js
#turnCount = 0;
```

At the top of the file, after the imports, add:

```js
const BRIDGE_HTTP = `http://localhost:${process.env.PORT || 3000}`;
const MAX_TURNS = 10;
const KNOWN_AGENTS = ['analyst', 'implementer', 'verifier', 'user'];
```

**Step 3: Add `#fetchHistory` method**

After the `#send` method, add:

```js
async #fetchHistory(limit = 20) {
  try {
    const headers = process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {};
    const res = await fetch(`${BRIDGE_HTTP}/conversation?limit=${limit}`, { headers });
    if (!res.ok) return '';
    const data = await res.json();
    return data.messages
      .map(m => `[${m.sender}] ${m.content}`)
      .join('\n');
  } catch {
    return '';
  }
}
```

**Step 4: Update the `#handle` method**

Replace the existing `#handle` method with:

```js
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
  const contextualPrompt = history
    ? `${this.#systemPrompt}\n\n--- Conversation so far ---\n${history}\n--- End of conversation ---\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`
    : `${this.#systemPrompt}\n\nAlways end your response with @mention to pass the turn: @analyst, @implementer, @verifier, or @user.`;

  let response;
  try {
    response = await callClaude(contextualPrompt, content);
  } catch (err) {
    console.error(`[${this.#name}] LLM error: ${err.message}`);
    response = `Error processing message: ${err.message} @user`;
  }

  // Parse @mention for routing; fall back to user if none found
  const rawMention = parseMention(response);
  const next = (rawMention && rawMention !== this.#name && KNOWN_AGENTS.includes(rawMention))
    ? rawMention
    : 'user';

  const preview = response.slice(0, 120) + (response.length > 120 ? '…' : '');

  if (next === 'user') {
    this.#turnCount = 0; // reset on user handoff
    console.log(`[${this.#name}] → user: ${preview}`);
  } else {
    console.log(`[${this.#name}] → ${next}: ${preview}`);
  }

  this.#send({ type: 'message', from: this.#name, to: next, payload: response });
}
```

**Step 5: Manual smoke test**

Start bridge + agents and send one message (requires valid `ANTHROPIC_API_KEY`):

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run agents

# Terminal 3 (PowerShell)
$body = '{"sender":"user","recipient":"analyst","content":"Explain what Agent-Bridge does in one sentence. @implementer"}'
Invoke-RestMethod -Uri http://localhost:3000/publish_message -Method POST -ContentType "application/json" -Body $body
```

Expected: agents pass the turn to each other via @mention, eventually returning to @user.

**Step 6: Commit**

```bash
git add scripts/agents/agent-worker.mjs
git commit -m "feat: AgentWorker fetches conversation history and routes via @mention"
```

---

## Task 5: Create chat UI — `dashboard/chat.html`

**Files:**
- Create: `dashboard/chat.html`

**Step 1: Create the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent-Bridge Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; display: flex; flex-direction: column; height: 100vh; }
    header { padding: 12px 20px; background: #1a1d2e; border-bottom: 1px solid #2a2d3e; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1rem; font-weight: 600; }
    #status { font-size: 0.75rem; color: #888; }
    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .bubble { max-width: 75%; padding: 10px 14px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .bubble .meta { font-size: 0.7rem; opacity: 0.6; margin-bottom: 4px; }
    .from-user   { align-self: flex-end; background: #2563eb; color: #fff; }
    .from-analyst     { align-self: flex-start; background: #1e3a2f; border: 1px solid #16a34a; }
    .from-implementer { align-self: flex-start; background: #1e2a3a; border: 1px solid #3b82f6; }
    .from-verifier    { align-self: flex-start; background: #2a1e3a; border: 1px solid #a855f7; }
    .from-system      { align-self: center; background: #1a1a1a; color: #888; font-size: 0.8rem; padding: 4px 10px; border-radius: 8px; }
    #approval-bar { display: none; padding: 12px 20px; background: #1a1d2e; border-top: 1px solid #2a2d3e; gap: 10px; align-items: center; justify-content: center; }
    #approval-bar span { margin-right: 12px; font-size: 0.9rem; }
    button.yes { background: #16a34a; color: #fff; border: none; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; }
    button.no  { background: #dc2626; color: #fff; border: none; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; }
    #composer { display: flex; padding: 12px 16px; gap: 10px; background: #1a1d2e; border-top: 1px solid #2a2d3e; }
    #input { flex: 1; background: #0f1117; border: 1px solid #2a2d3e; color: #e0e0e0; padding: 10px 14px; border-radius: 8px; font-size: 0.95rem; resize: none; outline: none; }
    #input:focus { border-color: #3b82f6; }
    button#send { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 0.95rem; }
    button#send:disabled { opacity: 0.4; cursor: default; }
  </style>
</head>
<body>
  <header>
    <h1>Agent-Bridge Chat</h1>
    <span id="status">connecting…</span>
  </header>

  <div id="messages"></div>

  <div id="approval-bar">
    <span>Agents are done — approve?</span>
    <button class="yes" onclick="approve(true)">YES ✓</button>
    <button class="no"  onclick="approve(false)">NO ✗</button>
  </div>

  <div id="composer">
    <textarea id="input" rows="2" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send" onclick="sendMessage()">Send</button>
  </div>

  <script>
    const API_KEY = localStorage.getItem('agent-bridge-api-key') || '';
    const headers = (extra = {}) => ({
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      ...extra,
    });

    const $messages = document.getElementById('messages');
    const $status   = document.getElementById('status');
    const $approval = document.getElementById('approval-bar');
    const $input    = document.getElementById('input');
    const $send     = document.getElementById('send');

    // ── Render helpers ──────────────────────────────────────────────────────

    function addBubble(sender, recipient, content, ts) {
      const role = (sender || 'unknown').toLowerCase();
      const cls  = `from-${role === 'user' ? 'user' : role}`;
      const time = ts ? new Date(ts).toLocaleTimeString() : '';
      const div  = document.createElement('div');
      div.className = `bubble ${cls}`;
      div.innerHTML = `<div class="meta">${sender} → ${recipient} &nbsp;${time}</div>${escHtml(content)}`;
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
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Load history ────────────────────────────────────────────────────────

    async function loadHistory() {
      try {
        const res = await fetch('/conversation?limit=50', { headers: headers() });
        if (!res.ok) return;
        const data = await res.json();
        for (const m of data.messages) {
          addBubble(m.sender, m.recipient, m.content, m.timestamp);
        }
        if (data.messages.length) addSystem('— history loaded —');
      } catch { /* bridge not ready yet */ }
    }

    // ── SSE for live updates ─────────────────────────────────────────────────

    function connectSSE() {
      const url = API_KEY ? `/events?key=${encodeURIComponent(API_KEY)}` : '/events';
      const es  = new EventSource(url);

      es.onopen = () => { $status.textContent = 'connected'; $status.style.color = '#16a34a'; };
      es.onerror = () => { $status.textContent = 'reconnecting…'; $status.style.color = '#f59e0b'; };

      es.addEventListener('message', e => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'message.published') {
            const p = event.payload;
            // Fetch the actual message content (event only has IDs)
            fetchAndRender(p.messageId);
          }
        } catch {}
      });
    }

    async function fetchAndRender(messageId) {
      // Re-fetch last message from /conversation since events don't include content
      try {
        const res = await fetch('/conversation?limit=1', { headers: headers() });
        if (!res.ok) return;
        const data = await res.json();
        const m = data.messages.find(x => x.id === messageId) || data.messages[data.messages.length - 1];
        if (m) addBubble(m.sender, m.recipient, m.content, m.timestamp);
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
      const mention = content.match(/@(analyst|implementer|verifier)/i);
      const recipient = mention ? mention[1].toLowerCase() : 'analyst';

      try {
        await fetch('/publish_message', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ sender: 'user', recipient, content }),
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
      if (yes) {
        addSystem('✓ Task approved by user.');
      } else {
        $input.focus();
        addSystem('✗ Task rejected — type what should change.');
      }
    }

    // ── Keyboard shortcut ────────────────────────────────────────────────────

    $input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // ── Boot ─────────────────────────────────────────────────────────────────

    loadHistory();
    connectSSE();
  </script>
</body>
</html>
```

**Step 2: Verify the file is served**

The bridge already serves `dashboard/` at `/dashboard`. Check that chat.html is accessible:

```bash
npm run dev &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/dashboard/chat.html
```

Expected: `200`

Kill the background server after testing.

**Step 3: Commit**

```bash
git add dashboard/chat.html
git commit -m "feat: add conversational chat UI at /dashboard/chat.html"
```

---

## Task 6: Full verification

**Step 1: Run all tests**

```bash
npm test
npm run lint
```

Expected: all tests pass, 0 TypeScript errors.

**Step 2: Manual end-to-end test**

1. Set a valid `ANTHROPIC_API_KEY` in `.env`
2. Terminal 1: `npm run dev`
3. Terminal 2: `npm run agents`
4. Open browser: `http://localhost:3000/dashboard/chat.html`
5. Type: "Design a simple REST endpoint for user login. @analyst"
6. Watch agents converse in real time
7. Click YES when the approval bar appears

Expected: full conversation visible, turn passes via @mention, approval bar appears after verifier.

**Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: resolve any remaining issues from end-to-end test"
```

---

## Task 7: Push PR and merge

**Step 1: Push branch**

```bash
git push -u origin feat/conversational-agents
```

**Step 2: Create PR**

```bash
gh pr create --base main --head feat/conversational-agents \
  --title "feat: conversational multi-agent chat with @mention routing" \
  --body "Adds GET /conversation endpoint, updates AgentWorker to fetch history and route via @mention, and creates a real-time chat UI at /dashboard/chat.html. Includes loop protection (max 10 turns, 60s timeout fallback to @user)."
```

**Step 3: Merge after CI passes**

```bash
gh pr merge --merge
```

**Step 4: Delete branch**

```bash
git checkout main && git pull
git branch -d feat/conversational-agents
```
