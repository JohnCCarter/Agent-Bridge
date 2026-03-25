# Myceliummergi Dashboard – Visual Redesign

**Date:** 2026-03-25
**Status:** Approved
**Goal:** Transform the static list-based dashboard into a living, breathing visualisation
that proves Agent-Bridge is a real, working ecosystem — not just a data table.

---

## Problem

The current `/mycelium` dashboard shows data (leaderboard, pheromones, trust, triggers) as
styled HTML lists. Data updates every 3 seconds via polling + SSE, but the experience feels
static. There is no visual representation of *relationships* or *movement* — the two things
that would make the ecosystem feel alive.

---

## Design

### Layout (top → bottom)

```
┌─────────────────────────────────────────────────────────┐
│  🕸️  NÄTVERKSGRAF  (full width, ~350px tall)             │
│  Agents as pulsing nodes                                 │
│  Trust = green animated edges                            │
│  Pheromones = purple dashed animated edges               │
│  Messages = particles flying along edges                 │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  ⚡ PIPELINE  Analyst ──▶ Implementer ──▶ Verifier       │
│  Contracts as cards sliding through the stages           │
└─────────────────────────────────────────────────────────┘
┌──────────┬──────────┬──────────┬────────────────────────┐
│Leaderboard│Pheromones│  Trust   │  Triggers  │ Nervström │
└──────────┴──────────┴──────────┴────────────┴───────────┘
```

---

## Network Graph

**Library:** D3.js v7 via CDN (no build step).

**Nodes** — one per agent from `GET /agents`:
- Radius proportional to `totalScore` from leaderboard (min 18px, max 48px)
- Fill: green if online, grey if offline
- Label: agent name
- Pulse ring animation on `agent.connected`, `trigger.fired`, `message.sent`

**Edges** — two types, both dynamic:
1. **Trust edges** (from `GET /trust`):
   - Green stroke, width proportional to `score` (0–1)
   - Solid line
   - Label: capability name
2. **Pheromone trails** (from `GET /pheromones`):
   - Purple (`--spore`) dashed stroke, animated dash-offset (marching ants)
   - Width proportional to `strength` (0–1)
   - Label: capability name

**Particles** — triggered by SSE events (`trigger.fired`, `pheromone.reinforced`,
`contract.updated`): a small glowing dot travels from sender-node to receiver-node along
the edge using a CSS/SVG animation.

**Physics:** D3 `forceSimulation` with:
- `forceManyBody` (repulsion between nodes)
- `forceLink` (attraction along edges)
- `forceCenter` (keeps graph centred)
- `forceCollide` (prevents node overlap)

Simulation runs on load and settles; re-heats on node add/remove.

---

## Pipeline

**Three labelled stages:** Analyst · Implementer · Verifier

Active contracts (status: `proposed`, `accepted`, `in_progress`, `review`) appear as cards.
Each card shows:
- Contract title (truncated)
- Priority badge
- Time since `createdAt`

Cards animate left-to-right as status changes:
- `proposed` / `accepted` → Analyst column
- `in_progress` → Implementer column
- `review` → Verifier column
- `completed` / `failed` → card flies off right edge and fades out

Animation: CSS `transform: translateX` + `opacity` transition (300ms ease).

---

## Detail Panels (unchanged data, smaller cards)

Existing panels demoted to a bottom row:
- 🏆 Leaderboard
- 🐜 Pheromone Trails
- 🤝 Trust Graph
- ⚡ Triggers
- 🌐 Nervström (live events)

Topics panel removed from bottom row (shown in network graph implicitly).

---

## Data Flow

No new endpoints. All data comes from existing sources:

| Panel | Source |
|---|---|
| Network graph nodes | `GET /agents` (poll) + `agent.connected` / `agent.disconnected` (SSE) |
| Trust edges | `GET /trust` (poll) + `trust.updated` (SSE → immediate re-poll) |
| Pheromone edges | `GET /pheromones` (poll) + `pheromone.reinforced` (SSE → immediate re-poll) |
| Pipeline cards | `GET /contracts` (poll) + `contract.updated` (SSE → immediate re-poll) |
| Particles | `trigger.fired`, `pheromone.reinforced` (SSE only) |

Polling interval stays at 3 seconds. Fast-path SSE events trigger an immediate re-poll
(already implemented in `mycelium.js`).

---

## Files Changed

| File | Change |
|---|---|
| `dashboard/mycelium.html` | Add D3 v7 CDN link; restructure `<main>` with graph + pipeline sections |
| `dashboard/mycelium.js` | Add D3 force graph module + pipeline renderer; wire into existing `poll()` / SSE |
| `dashboard/mycelium.css` | New styles: graph container, node/edge/particle styles, pipeline columns, card animations |

No backend changes required.

---

## Aesthetic

- Dark background (`#0d0d12`) — existing
- Nodes: `#4ade80` (green/online), `#6b7280` (grey/offline)
- Trust edges: `#22c55e` (green)
- Pheromone edges: `#a855f7` (purple, `--spore`)
- Particles: `#fde68a` (amber glow)
- Pipeline cards: existing badge/status colours

---

## Out of Scope

- Groq / Ollama LLM integration (separate task)
- Autonomous task generation (separate task)
- 3D visualisation
- Mobile layout changes
