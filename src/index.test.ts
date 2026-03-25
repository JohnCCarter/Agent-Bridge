import request from "supertest";
import axios from "axios";
import EventSource from "eventsource";
import http from "http";
import { AddressInfo } from "net";
import app, { clearEventHistory, stopBackgroundTimers, clearConversationHistory, sweepStaleClaims } from "./index";
import { clearContractsStore, checkOverdueContracts } from "./contracts";

// Stop the global message-prune timer so Jest exits cleanly
afterAll(() => stopBackgroundTimers());

type SSEMessageEvent = { data?: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, timeout = 1000, interval = 25): Promise<void> {
  const start = Date.now();
  while (true) {
    if (condition()) {
      return;
    }
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(interval);
  }
}

describe("Agent-Bridge MCP Server", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
    clearConversationHistory();
  });

  describe("Message Operations", () => {
    it("should publish, fetch, and acknowledge messages", async () => {
      const recipient = "test-user";
      const content = "Hello, this is a test message";

      const publishResponse = await request(app)
        .post("/publish_message")
        .send({ recipient, content, sender: "cursor" })
        .expect(201);

      expect(publishResponse.body.success).toBe(true);
      expect(publishResponse.body.messageId).toBeDefined();
      const messageId = publishResponse.body.messageId;

      const fetchResponse = await request(app)
        .get(`/fetch_messages/${recipient}`)
        .expect(200);

      expect(fetchResponse.body.success).toBe(true);
      expect(fetchResponse.body.messages).toHaveLength(1);
      expect(fetchResponse.body.messages[0].id).toBe(messageId);
      expect(fetchResponse.body.messages[0].content).toBe(content);
      expect(fetchResponse.body.messages[0].sender).toBe("cursor");
      expect(fetchResponse.body.messages[0].acknowledged).toBe(false);

      const ackResponse = await request(app)
        .post("/ack_message")
        .send({ ids: [messageId] })
        .expect(200);

      expect(ackResponse.body.success).toBe(true);
      expect(ackResponse.body.acknowledgedCount).toBe(1);

      const fetchAfterAckResponse = await request(app)
        .get(`/fetch_messages/${recipient}`)
        .expect(200);

      expect(fetchAfterAckResponse.body.success).toBe(true);
      expect(fetchAfterAckResponse.body.messages).toHaveLength(0);
    });

    it("should handle invalid publish message data", async () => {
      const response = await request(app)
        .post("/publish_message")
        .send({ recipient: "", content: "" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid request data");
    });

    it("should handle invalid ack message data", async () => {
      const response = await request(app)
        .post("/ack_message")
        .send({ ids: "not-an-array" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid request data");
    });
  });

  describe("Task Contracts", () => {
    it("should create and fetch a task contract", async () => {
      const createPayload = {
        title: "Investigate performance",
        description: "Review performance hotspots",
        initiator: "cursor",
        owner: "codex",
        priority: "high",
        tags: ["performance"],
        files: ["src/index.ts"],
        metadata: { sprint: "alpha" }
      };

      const createResponse = await request(app)
        .post("/contracts")
        .send(createPayload)
        .expect(201);

      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.contract).toBeDefined();
      const contractId = createResponse.body.contract.id;
      expect(createResponse.body.contract.status).toBe("proposed");
      expect(createResponse.body.contract.history).toHaveLength(1);

      const fetchResponse = await request(app)
        .get(`/contracts/${contractId}`)
        .expect(200);

      expect(fetchResponse.body.success).toBe(true);
      expect(fetchResponse.body.contract.id).toBe(contractId);
      expect(fetchResponse.body.contract.priority).toBe("high");
    });

    it("should return 404 when fetching a missing contract", async () => {
      const response = await request(app)
        .get("/contracts/missing-contract")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Contract not found");
    });

    it("should create a contract when publishing a message", async () => {
      const publishResponse = await request(app)
        .post("/publish_message")
        .send({
          recipient: "codex-agent",
          content: "Analyse latest changes",
          sender: "cursor-agent",
          contract: {
            title: "Analyse changes",
            initiator: "cursor-agent",
            owner: "codex-agent",
            priority: "medium",
            tags: ["analysis"],
            files: ["src/index.ts"]
          }
        })
        .expect(201);

      expect(publishResponse.body.success).toBe(true);
      expect(publishResponse.body.contractId).toBeDefined();
      expect(publishResponse.body.contract.status).toBe("proposed");

      const contractId = publishResponse.body.contractId;

      const contractResponse = await request(app)
        .get(`/contracts/${contractId}`)
        .expect(200);

      expect(contractResponse.body.contract.id).toBe(contractId);
      expect(contractResponse.body.contract.relatedMessageId).toBe(publishResponse.body.messageId);

      const messagesResponse = await request(app)
        .get("/fetch_messages/codex-agent")
        .expect(200);

      expect(messagesResponse.body.messages[0].contractId).toBe(contractId);
    });

    it("should update a contract status and history", async () => {
      const createResponse = await request(app)
        .post("/contracts")
        .send({
          title: "Audit security",
          initiator: "cursor",
          owner: "codex"
        })
        .expect(201);

      const contractId = createResponse.body.contract.id;

      // proposed → accepted
      await request(app)
        .patch(`/contracts/${contractId}/status`)
        .send({ status: "accepted", actor: "codex" })
        .expect(200);

      // accepted → in_progress
      const updateResponse = await request(app)
        .patch(`/contracts/${contractId}/status`)
        .send({
          status: "in_progress",
          owner: "codex",
          note: "Work started",
          actor: "codex"
        })
        .expect(200);

      expect(updateResponse.body.success).toBe(true);
      expect(updateResponse.body.contract.status).toBe("in_progress");
      expect(updateResponse.body.contract.history).toHaveLength(3);
      expect(updateResponse.body.contract.history[2].note).toBe("Work started");

      const fetchResponse = await request(app)
        .get(`/contracts/${contractId}`)
        .expect(200);

      expect(fetchResponse.body.contract.status).toBe("in_progress");
    });

    it("should return 404 when referencing missing contract from message", async () => {
      const response = await request(app)
        .post("/publish_message")
        .send({
          recipient: "codex",
          content: "Check this contract",
          sender: "cursor",
          contractId: "missing-contract-id"
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Contract not found");
    });

    it('GET /contracts should return all contracts as array', async () => {
      await request(app)
        .post('/contracts')
        .send({ title: 'Contract A', description: 'desc', initiator: 'analyst', priority: 'medium' });
      await request(app)
        .post('/contracts')
        .send({ title: 'Contract B', description: 'desc', initiator: 'implementer', priority: 'high' });

      const res = await request(app).get('/contracts');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('contracts');
      expect(Array.isArray(res.body.contracts)).toBe(true);
      expect(res.body.contracts.length).toBe(2);
      expect(res.body.contracts[0]).toHaveProperty('id');
      expect(res.body.contracts[0]).toHaveProperty('title');
    });
  });

  describe("Resource Locking Operations", () => {
    it("should lock, renew, and unlock resources", async () => {
      const resource = "test-resource";
      const holder = "test-holder";
      const ttl = 30;

      const lockResponse = await request(app)
        .post("/lock_resource")
        .send({ resource, holder, ttl })
        .expect(201);

      expect(lockResponse.body.success).toBe(true);
      expect(lockResponse.body.lock.resource).toBe(resource);
      expect(lockResponse.body.lock.holder).toBe(holder);
      expect(lockResponse.body.lock.ttl).toBe(ttl);

      const duplicateLockResponse = await request(app)
        .post("/lock_resource")
        .send({ resource, holder: "another-holder", ttl: 60 })
        .expect(409);

      expect(duplicateLockResponse.body.success).toBe(false);
      expect(duplicateLockResponse.body.error).toBe("Resource is already locked");

      const renewResponse = await request(app)
        .post("/renew_lock")
        .send({ resource, holder, ttl: 60 })
        .expect(200);

      expect(renewResponse.body.success).toBe(true);
      expect(renewResponse.body.lock.ttl).toBe(60);

      const unlockResponse = await request(app)
        .delete(`/unlock_resource/${resource}?holder=${holder}`)
        .expect(200);

      expect(unlockResponse.body.success).toBe(true);

      const relockResponse = await request(app)
        .post("/lock_resource")
        .send({ resource, holder: "new-holder", ttl: 30 })
        .expect(201);

      expect(relockResponse.body.success).toBe(true);
      expect(relockResponse.body.lock.holder).toBe("new-holder");
    });

    it("should handle invalid lock resource data", async () => {
      const response = await request(app)
        .post("/lock_resource")
        .send({ resource: "", holder: "", ttl: -1 })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid request data");
    });

    it("should handle renewing non-existent lock", async () => {
      const response = await request(app)
        .post("/renew_lock")
        .send({ resource: "non-existent-resource", holder: "someone", ttl: 30 })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Lock not found");
    });

    it("should handle unlocking non-existent resource", async () => {
      const response = await request(app)
        .delete("/unlock_resource/non-existent-resource")
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Lock not found");
    });
  });

  describe("Health Check", () => {
    it("should return health status", async () => {
      const response = await request(app)
        .get("/health")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Agent-Bridge server is running");
      expect(response.body.timestamp).toBeDefined();
    });
  });

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
      expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
      const last2 = res.body.messages.slice(-2);
      expect(last2[0].sender).toBe('user');
      expect(last2[1].sender).toBe('analyst');
    });

    it('respects ?limit param', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).post('/publish_message')
          .send({ sender: 'user', recipient: 'analyst', content: `msg${i}` });
      }
      const res = await request(app).get('/conversation?limit=3');
      expect(res.body.messages.length).toBeLessThanOrEqual(3);
    });
  });

  describe("Event Stream", () => {
    let server: http.Server;
    let baseUrl: string;
    let client: ReturnType<typeof axios.create>;

    beforeAll(async () => {
      server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      client = axios.create({ baseURL: baseUrl, timeout: 1000 });
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("streams contract events when publishing a message with contract", async () => {
      const received: Array<{ type: string; payload: any }> = [];
      const es = new EventSource(`${baseUrl}/events`, { headers: { "User-Agent": "jest-event-test" } });

      const record = (type: string) => (event: SSEMessageEvent) => {
        const payload = event.data ? JSON.parse(event.data) : null;
        received.push({ type, payload });
      };

      es.addEventListener("contract.created", record("contract.created"));
      es.addEventListener("contract.message_linked", record("contract.message_linked"));
      es.addEventListener("message.published", record("message.published"));

      await new Promise<void>((resolve, reject) => {
        es.onopen = () => resolve();
        es.onerror = (err: any) => reject(err);
      });

      await client.post("/publish_message", {
        recipient: "codex-agent",
        sender: "cursor-agent",
        content: JSON.stringify({ task: "Analyse TypeScript config" }),
        contract: {
          title: "Analyse TypeScript config",
          initiator: "cursor-agent",
          owner: "codex-agent",
          priority: "high",
          tags: ["analysis"],
          files: ["tsconfig.json"]
        }
      });

      await waitFor(() => received.filter(e => e.type === "message.published").length >= 1, 1500);

      es.close();

      const types = received.map(e => e.type);
      expect(types).toEqual(expect.arrayContaining([
        "contract.created",
        "contract.message_linked",
        "message.published"
      ]));

      const contractEvent = received.find(e => e.type === "contract.created");
      expect(contractEvent?.payload.payload.contract.title).toBe("Analyse TypeScript config");
    });

    it("streams lock lifecycle events", async () => {
      const received: Array<{ type: string; payload: any }> = [];
      const es = new EventSource(`${baseUrl}/events`, { headers: { "User-Agent": "jest-lock-test" } });

      const record = (type: string) => (event: SSEMessageEvent) => {
        const payload = event.data ? JSON.parse(event.data) : null;
        received.push({ type, payload });
      };

      es.addEventListener("lock.created", record("lock.created"));
      es.addEventListener("lock.renewed", record("lock.renewed"));
      es.addEventListener("lock.released", record("lock.released"));

      await new Promise<void>((resolve, reject) => {
        es.onopen = () => resolve();
        es.onerror = (err: any) => reject(err);
      });

      await client.post("/lock_resource", {
        resource: "src/index.ts",
        holder: "codex",
        ttl: 60
      });

      await client.post("/renew_lock", {
        resource: "src/index.ts",
        holder: "codex",
        ttl: 120
      });

      await client.delete("/unlock_resource/src%2Findex.ts?holder=codex");

      await waitFor(() => received.filter(e => e.type === "lock.released").length >= 1, 1500);

      es.close();

      const types = received.map(e => e.type);
      expect(types).toEqual(expect.arrayContaining(["lock.created", "lock.renewed", "lock.released"]));
    });
  });
});

// ── Hierarchical contracts ────────────────────────────────────────────────────

describe("Hierarchical contracts", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
  });

  it("should create a subtask under a parent contract", async () => {
    const parent = await request(app)
      .post("/contracts")
      .send({ title: "Parent task", initiator: "user", owner: "analyst" })
      .expect(201);
    const parentId = parent.body.contract.id;

    const child = await request(app)
      .post(`/contracts/${parentId}/subtasks`)
      .send({ title: "Child task", initiator: "analyst", owner: "implementer" })
      .expect(201);

    expect(child.body.success).toBe(true);
    expect(child.body.contract.parentId).toBe(parentId);
    expect(child.body.contract.childIds).toHaveLength(0);
  });

  it("should list subtasks of a parent contract", async () => {
    const parent = await request(app)
      .post("/contracts")
      .send({ title: "Epic", initiator: "user" })
      .expect(201);
    const parentId = parent.body.contract.id;

    await request(app)
      .post(`/contracts/${parentId}/subtasks`)
      .send({ title: "Story A", initiator: "analyst" })
      .expect(201);
    await request(app)
      .post(`/contracts/${parentId}/subtasks`)
      .send({ title: "Story B", initiator: "analyst" })
      .expect(201);

    const list = await request(app)
      .get(`/contracts/${parentId}/subtasks`)
      .expect(200);

    expect(list.body.success).toBe(true);
    expect(list.body.subtasks).toHaveLength(2);
    expect(list.body.subtasks.map((s: any) => s.title)).toEqual(
      expect.arrayContaining(["Story A", "Story B"])
    );
  });

  it("should update parent childIds when subtask is created", async () => {
    const parent = await request(app)
      .post("/contracts")
      .send({ title: "Root", initiator: "user" })
      .expect(201);
    const parentId = parent.body.contract.id;

    const child = await request(app)
      .post(`/contracts/${parentId}/subtasks`)
      .send({ title: "Sub", initiator: "analyst" })
      .expect(201);
    const childId = child.body.contract.id;

    const fetched = await request(app)
      .get(`/contracts/${parentId}`)
      .expect(200);
    expect(fetched.body.contract.childIds).toContain(childId);
  });

  it("should return 404 for subtasks of non-existent parent", async () => {
    await request(app)
      .post("/contracts/nonexistent/subtasks")
      .send({ title: "Orphan", initiator: "analyst" })
      .expect(404);
  });
});

// ── Capability routing (REST) ─────────────────────────────────────────────────

describe("Capability routing", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
  });

  it("should reject publish_message without recipient or capability", async () => {
    await request(app)
      .post("/publish_message")
      .send({ content: "hello" })
      .expect(400);
  });

  it("should reject publish_message with both recipient and capability", async () => {
    await request(app)
      .post("/publish_message")
      .send({ recipient: "alice", capability: "code-review", content: "hello" })
      .expect(400);
  });

  it("should queue capability message when no capable agent is online", async () => {
    const res = await request(app)
      .post("/publish_message")
      .send({ capability: "code-review", content: "please review", sender: "user" })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.capability).toBe("code-review");
  });

  it("GET /capabilities returns registered capability info", async () => {
    await request(app)
      .post("/agents/register")
      .send({ name: "reviewer-1", type: "ws-agent", capabilities: ["code-review", "testing"] })
      .expect(201);

    const res = await request(app).get("/capabilities").expect(200);
    expect(res.body.success).toBe(true);
    const caps = res.body.capabilities as any[];
    const review = caps.find((c: any) => c.capability === "code-review");
    expect(review).toBeDefined();
    expect(review.agents).toContain("reviewer-1");
  });
});

// ── Work claiming ─────────────────────────────────────────────────────────────

describe("Work claiming", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
  });

  it("should return 404 when no work is queued for capability", async () => {
    await request(app)
      .post("/claim_work")
      .send({ capability: "nonexistent-cap", claimant: "agent-1" })
      .expect(404);
  });

  it("should claim a queued capability message", async () => {
    // Publish a capability message (no agent online → queued)
    await request(app)
      .post("/publish_message")
      .send({ capability: "security-audit", content: "audit this", sender: "user" })
      .expect(201);

    // Claim the work
    const claim = await request(app)
      .post("/claim_work")
      .send({ capability: "security-audit", claimant: "security-agent" })
      .expect(200);

    expect(claim.body.success).toBe(true);
    expect(claim.body.messageId).toBeTruthy();
    expect(claim.body.message.content).toBe("audit this");
  });

  it("should not return same work twice", async () => {
    await request(app)
      .post("/publish_message")
      .send({ capability: "unique-cap", content: "do it once", sender: "user" })
      .expect(201);

    await request(app)
      .post("/claim_work")
      .send({ capability: "unique-cap", claimant: "agent-a" })
      .expect(200);

    // Second claim should find nothing
    await request(app)
      .post("/claim_work")
      .send({ capability: "unique-cap", claimant: "agent-b" })
      .expect(404);
  });
});

// ── Agent thoughts ────────────────────────────────────────────────────────────

describe("Agent thoughts (REST)", () => {
  beforeEach(() => {
    clearEventHistory();
  });

  it("should store and retrieve a thought", async () => {
    await request(app)
      .post("/agents/register")
      .send({ name: "thinker", type: "llm-agent", capabilities: [] })
      .expect(201);

    await request(app)
      .post("/agents/thinker/thoughts")
      .send({ reasoning: "I am analysing the code", phase: "analysis", progress: 0.2 })
      .expect(201);

    const res = await request(app)
      .get("/agents/thinker/thoughts")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.thoughts).toHaveLength(1);
    const t = res.body.thoughts[0];
    expect(t.reasoning).toBe("I am analysing the code");
    expect(t.phase).toBe("analysis");
    expect(t.progress).toBeCloseTo(0.2);
  });

  it("should return 404 for thoughts of unknown agent", async () => {
    await request(app).get("/agents/ghost/thoughts").expect(404);
    await request(app)
      .post("/agents/ghost/thoughts")
      .send({ reasoning: "nobody home" })
      .expect(404);
  });
});

// ── Claim timeout / sweepStaleClaims ──────────────────────────────────────────

describe("sweepStaleClaims", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
  });

  it("should re-queue a claimed message after the timeout", async () => {
    // Queue a capability message (no online agent → goes to capabilityQueues)
    await request(app)
      .post("/publish_message")
      .send({ capability: "sweep-test-cap", content: "sweep me", sender: "user" })
      .expect(201);

    // First agent claims it
    const claim = await request(app)
      .post("/claim_work")
      .send({ capability: "sweep-test-cap", claimant: "flaky-agent" })
      .expect(200);
    expect(claim.body.success).toBe(true);
    const msgId = claim.body.messageId;

    // Second claim should find nothing (already claimed)
    await request(app)
      .post("/claim_work")
      .send({ capability: "sweep-test-cap", claimant: "other-agent" })
      .expect(404);

    // Manually backdate claimedAt so the sweep sees it as stale
    // We do this by running sweep with a patched clock via jest fake timers
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 6 * 60 * 1000); // 6 minutes forward
    sweepStaleClaims();
    jest.useRealTimers();

    // Now the work should be back in the queue – another agent can claim it
    const reclaim = await request(app)
      .post("/claim_work")
      .send({ capability: "sweep-test-cap", claimant: "other-agent" })
      .expect(200);
    expect(reclaim.body.success).toBe(true);
    expect(reclaim.body.messageId).toBe(msgId);
  });

  it("should not re-queue a message that was already ACKed before the sweep", async () => {
    await request(app)
      .post("/publish_message")
      .send({ capability: "ack-before-sweep-cap", content: "ack me", sender: "user" })
      .expect(201);

    const claim = await request(app)
      .post("/claim_work")
      .send({ capability: "ack-before-sweep-cap", claimant: "good-agent" })
      .expect(200);
    const msgId = claim.body.messageId;

    // ACK the message before the sweep fires
    await request(app)
      .post("/ack_message")
      .send({ ids: [msgId] })
      .expect(200);

    // Advance time and sweep
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 6 * 60 * 1000);
    sweepStaleClaims();
    jest.useRealTimers();

    // Queue should still be empty – ACKed messages are never re-queued
    await request(app)
      .post("/claim_work")
      .send({ capability: "ack-before-sweep-cap", claimant: "other-agent" })
      .expect(404);
  });
});

// ── Contract SLA (checkOverdueContracts) ──────────────────────────────────────

describe("Contract SLA", () => {
  beforeEach(() => {
    clearContractsStore();
    clearEventHistory();
  });

  it("should detect an overdue contract", async () => {
    // Create a contract with dueAt 1 hour in the past
    const pastDue = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post("/contracts")
      .send({
        title: "Overdue task",
        initiator: "sla-tester",
        dueAt: pastDue,
      })
      .expect(201);
    expect(res.body.success).toBe(true);

    const violations = checkOverdueContracts();
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe("Overdue task");
    expect(violations[0].overdueMs).toBeGreaterThan(0);
  });

  it("should not flag a contract with dueAt in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await request(app)
      .post("/contracts")
      .send({ title: "Future task", initiator: "sla-tester", dueAt: future })
      .expect(201);

    expect(checkOverdueContracts()).toHaveLength(0);
  });

  it("should not flag a completed contract even if past due", async () => {
    const pastDue = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const create = await request(app)
      .post("/contracts")
      .send({ title: "Done task", initiator: "sla-tester", dueAt: pastDue, status: "proposed" })
      .expect(201);
    const contractId = create.body.contract.id;

    // Walk state machine to completed
    await request(app).patch(`/contracts/${contractId}/status`).send({ actor: "system", status: "accepted" }).expect(200);
    await request(app).patch(`/contracts/${contractId}/status`).send({ actor: "system", status: "in_progress" }).expect(200);
    await request(app).patch(`/contracts/${contractId}/status`).send({ actor: "system", status: "completed" }).expect(200);

    expect(checkOverdueContracts()).toHaveLength(0);
  });

  it("should not flag a contract without a dueAt", async () => {
    await request(app)
      .post("/contracts")
      .send({ title: "No deadline", initiator: "sla-tester" })
      .expect(201);

    expect(checkOverdueContracts()).toHaveLength(0);
  });
});
