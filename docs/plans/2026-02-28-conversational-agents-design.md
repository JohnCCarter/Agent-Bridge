# Conversational Multi-Agent Chat — Design

**Date:** 2026-02-28
**Status:** Approved
**Partners:** JohnCCarter + Claude

---

## Goal

Replace the linear pipeline (analyst → implementer → verifier → done) with a
conversational model where the user and agents communicate naturally — like a
group chat — while keeping the system orderly and free of infinite loops.

---

## Approved Decisions

| Question | Decision |
|----------|----------|
| Interaction model | Hybrid: user delegates, agents work, user can jump in anytime |
| Interface | Web chat at `localhost:3000/chat` (browser); VS Code extension embeds it later |
| Agent freedom | Free conversation — agents can ask, debate, clarify — within their roles |
| User approval | User has final YES/NO before anything is considered "done" |
| Shared memory | All agents see the full conversation history (capped at 20 messages) |
| Turn control | `@mention` model — only the mentioned agent responds; no agent speaks unprompted |

---

## Architecture

### What stays the same

- `src/index.ts` — Express, WebSocket, SSE, `publish_message`, `fetch_messages`
- `AgentWorker` class structure — connect, listen, respond
- The bridge as the single message hub

### What changes

**`src/index.ts` — one new endpoint:**
```
GET /conversation?limit=20
  → returns ordered array of all messages (sender, recipient, content, timestamp)
```

**`scripts/agents/agent-worker.mjs` — three changes:**
1. On receiving a message: fetch `/conversation?limit=20` and include it as context in the Claude prompt
2. Parse `@mention` from Claude's response to determine the next recipient
3. If no `@mention` found: default to `@user` (always returns control to user when unsure)

**`dashboard/chat.html` — new file:**
- Chat bubbles, one colour per participant (user, analyst, implementer, verifier)
- Live updates via existing `/events` SSE stream
- Text input at the bottom, send on Enter or button click
- Calls `POST /publish_message` with `{ sender: "user", recipient: <parsed @mention or "analyst">, content }`
- Shows a **YES / NO** approval bar when verifier's message contains `@user`

---

## Conversation Flow

```
User types:      "Bygg en login-endpoint"
  → sent to analyst (default first recipient)

[analyst]        "Förstår. JWT auth. @implementer här är spec: ..."
  → bridge delivers to implementer

[implementer]    "Fråga: validera email-format? @analyst"
  → bridge delivers to analyst

[analyst]        "Ja, basic regex. @implementer"
  → bridge delivers to implementer

[implementer]    "Klar. Kod: [...]. @verifier granska."
  → bridge delivers to verifier

[verifier]       "Godkänt. Inga säkerhetsproblem. @user vill du köra?"
  → YES/NO bar visas för användaren

User clicks YES  → task marked complete
User clicks NO   → user skriver vad som ska ändras, nytt varv börjar
```

---

## Loop Protection

| Rule | Detail |
|------|--------|
| No self-mention | Agent may not `@mention` itself |
| Max turns | 10 `@mention` exchanges per task; after that bridge asks user to continue or stop |
| Timeout | If an agent doesn't respond within 60 s, bridge notifies user with a system message |
| Fallback | If Claude response has no `@mention`, recipient defaults to `@user` |

---

## Context Window Management

Each agent call includes the last **20 messages** from `/conversation` formatted as:

```
[user] Bygg en login-endpoint
[analyst] Förstår. JWT auth. @implementer här är spec...
[implementer] Fråga: validera email-format? @analyst
...
```

Prepended before the agent's own system prompt. Total context stays well within
Claude's limits for typical tasks.

---

## Files to create / modify

| File | Action |
|------|--------|
| `src/index.ts` | Add `GET /conversation` endpoint |
| `scripts/agents/agent-worker.mjs` | Add history fetch + `@mention` parsing |
| `dashboard/chat.html` | Create — chat UI |
| `src/index.ts` | Serve `dashboard/` statically (already done for `/dashboard`) |

---

## Out of scope (Phase 9+)

- Persistent conversation storage (SQLite)
- VS Code extension embedding the chat webview
- Multiple simultaneous conversation threads
- Agent memory across separate tasks
