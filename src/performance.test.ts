import request from 'supertest';
import app, { clearEventHistory } from './index';
import { clearContractsStore, flushContractPersistence } from './contracts';

describe('Performance Benchmarks', () => {
  beforeEach(() => {
    clearEventHistory();
    clearContractsStore();
  });

  describe('Message Operations Performance', () => {
    it('should handle message publishing at scale (1000 messages)', async () => {
      const startTime = Date.now();
      const messageCount = 1000;
      const recipients = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];

      // Publish 1000 messages
      for (let i = 0; i < messageCount; i++) {
        const recipient = recipients[i % recipients.length];
        await request(app)
          .post('/publish_message')
          .send({
            recipient,
            sender: 'benchmark-sender',
            content: `Message ${i}`
          });
      }

      const publishTime = Date.now() - startTime;

      // Fetch messages for each recipient (should be O(1) with Map)
      const fetchStartTime = Date.now();
      for (const recipient of recipients) {
        const response = await request(app)
          .get(`/fetch_messages/${recipient}`)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.messages).toHaveLength(messageCount / recipients.length);
      }
      const fetchTime = Date.now() - fetchStartTime;

      console.log(`\n📊 Message Performance:
  Published ${messageCount} messages in ${publishTime}ms (${(messageCount / publishTime * 1000).toFixed(2)} msg/sec)
  Fetched ${recipients.length} recipient queues in ${fetchTime}ms
  Average fetch time: ${(fetchTime / recipients.length).toFixed(2)}ms per recipient`);

      // Performance expectations (should complete quickly with Map optimization)
      expect(publishTime).toBeLessThan(10000); // 10 seconds for 1000 messages
      expect(fetchTime).toBeLessThan(500); // 500ms for all fetches (O(1) lookups)
    }, 30000); // 30 second timeout

    it('should handle message acknowledgment at scale (1000 messages)', async () => {
      const messageCount = 1000;
      const messageIds: string[] = [];

      // Publish messages
      for (let i = 0; i < messageCount; i++) {
        const response = await request(app)
          .post('/publish_message')
          .send({
            recipient: 'test-agent',
            sender: 'benchmark',
            content: `Message ${i}`
          });
        messageIds.push(response.body.messageId);
      }

      // Acknowledge all at once (should be O(n) with Map, not O(n²))
      const ackStartTime = Date.now();
      const ackResponse = await request(app)
        .post('/ack_message')
        .send({ ids: messageIds })
        .expect(200);
      const ackTime = Date.now() - ackStartTime;

      expect(ackResponse.body.acknowledgedCount).toBe(messageCount);

      console.log(`\n📊 Acknowledgment Performance:
  Acknowledged ${messageCount} messages in ${ackTime}ms (${(messageCount / ackTime * 1000).toFixed(2)} ack/sec)`);

      // With Map optimization, should be linear O(n), not quadratic
      expect(ackTime).toBeLessThan(1000); // Should complete in under 1 second
    }, 30000);
  });

  describe('Event Stream Performance', () => {
    it('should efficiently manage event history with circular buffer', async () => {
      const eventCount = 500; // More than EVENT_HISTORY_LIMIT (100)

      const startTime = Date.now();

      // Generate events by publishing messages
      for (let i = 0; i < eventCount; i++) {
        await request(app)
          .post('/publish_message')
          .send({
            recipient: 'benchmark-agent',
            sender: 'benchmark',
            content: `Event ${i}`
          });
      }

      const eventTime = Date.now() - startTime;

      console.log(`\n📊 Event Stream Performance:
  Generated ${eventCount} events in ${eventTime}ms
  Average: ${(eventTime / eventCount).toFixed(2)}ms per event`);

      // Circular buffer should maintain O(1) insertion even with overflow
      expect(eventTime / eventCount).toBeLessThan(20); // < 20ms per event on average
    }, 30000);
  });

  describe('Contract Operations Performance', () => {
    it('should handle rapid contract creation with debounced persistence', async () => {
      const contractCount = 50;

      const startTime = Date.now();

      // Create many contracts rapidly (should batch writes with debouncing)
      const contractPromises = [];
      for (let i = 0; i < contractCount; i++) {
        const promise = request(app)
          .post('/contracts')
          .send({
            title: `Performance Test Contract ${i}`,
            initiator: 'benchmark-user',
            priority: 'medium'
          });
        contractPromises.push(promise);
      }

      await Promise.all(contractPromises);

      const createTime = Date.now() - startTime;

      console.log(`\n📊 Contract Performance:
  Created ${contractCount} contracts in ${createTime}ms (${(contractCount / createTime * 1000).toFixed(2)} contracts/sec)
  Average: ${(createTime / contractCount).toFixed(2)}ms per contract`);

      // With async debounced persistence, should not block
      expect(createTime).toBeLessThan(5000); // Should complete in under 5 seconds

      // Flush debounced writes
      await flushContractPersistence();
    }, 30000);

    it('should handle rapid contract updates efficiently', async () => {
      // Create a contract first
      const createResponse = await request(app)
        .post('/contracts')
        .send({
          title: 'Update Performance Test',
          initiator: 'benchmark-user',
          priority: 'high'
        });

      const contractId = createResponse.body.contract.id;
      const updateCount = 20;

      const startTime = Date.now();

      // Rapid sequential updates (should batch with debouncing)
      for (let i = 0; i < updateCount; i++) {
        await request(app)
          .patch(`/contracts/${contractId}/status`)
          .send({
            actor: 'benchmark-user',
            note: `Update ${i}`,
            status: i % 2 === 0 ? 'in_progress' : 'proposed'
          });
      }

      const updateTime = Date.now() - startTime;

      console.log(`\n📊 Contract Update Performance:
  Updated contract ${updateCount} times in ${updateTime}ms
  Average: ${(updateTime / updateCount).toFixed(2)}ms per update`);

      // Should be fast with debounced async persistence
      expect(updateTime / updateCount).toBeLessThan(100); // < 100ms per update

      // Flush debounced writes
      await flushContractPersistence();
    }, 30000);
  });

  describe('Resource Locking Performance', () => {
    it('should handle concurrent lock operations efficiently', async () => {
      const lockCount = 100;

      const startTime = Date.now();

      // Create locks
      const lockPromises = [];
      for (let i = 0; i < lockCount; i++) {
        const promise = request(app)
          .post('/lock_resource')
          .send({
            resource: `resource-${i}`,
            holder: 'benchmark-agent',
            ttl: 60
          });
        lockPromises.push(promise);
      }

      await Promise.all(lockPromises);
      const lockTime = Date.now() - startTime;

      console.log(`\n📊 Lock Performance:
  Created ${lockCount} locks in ${lockTime}ms (${(lockCount / lockTime * 1000).toFixed(2)} locks/sec)`);

      expect(lockTime).toBeLessThan(3000); // Should complete quickly
    }, 30000);
  });
});
