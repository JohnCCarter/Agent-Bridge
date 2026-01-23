import request from "supertest";
import axios from "axios";
import EventSource from "eventsource";
import http from "http";
import { AddressInfo } from "net";
import app, { clearEventHistory } from "./index";
import { clearContractsStore } from "./contracts";

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
      expect(updateResponse.body.contract.history).toHaveLength(2);
      expect(updateResponse.body.contract.history[1].note).toBe("Work started");

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
        .send({ resource, ttl: 60 })
        .expect(200);

      expect(renewResponse.body.success).toBe(true);
      expect(renewResponse.body.lock.ttl).toBe(60);

      const unlockResponse = await request(app)
        .delete(`/unlock_resource/${resource}`)
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
        .send({ resource: "non-existent-resource", ttl: 30 })
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
      expect(contractEvent?.payload.data.contract.title).toBe("Analyse TypeScript config");
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
        ttl: 120
      });

      await client.delete("/unlock_resource/src%2Findex.ts");

      await waitFor(() => received.filter(e => e.type === "lock.released").length >= 1, 1500);

      es.close();

      const types = received.map(e => e.type);
      expect(types).toEqual(expect.arrayContaining(["lock.created", "lock.renewed", "lock.released"]));
    });
  });
});
