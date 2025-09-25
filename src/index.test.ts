import request from 'supertest';
import app from './index';

describe('Agent-Bridge MCP Server', () => {
  describe('Message Operations', () => {
    it('should publish, fetch, and acknowledge messages', async () => {
      const recipient = 'test-user';
      const content = 'Hello, this is a test message';

      // 1. Publish a message
      const publishResponse = await request(app)
        .post('/publish_message')
        .send({ recipient, content })
        .expect(201);

      expect(publishResponse.body.success).toBe(true);
      expect(publishResponse.body.messageId).toBeDefined();
      const messageId = publishResponse.body.messageId;

      // 2. Fetch messages for the recipient
      const fetchResponse = await request(app)
        .get(`/fetch_messages/${recipient}`)
        .expect(200);

      expect(fetchResponse.body.success).toBe(true);
      expect(fetchResponse.body.messages).toHaveLength(1);
      expect(fetchResponse.body.messages[0].id).toBe(messageId);
      expect(fetchResponse.body.messages[0].content).toBe(content);
      expect(fetchResponse.body.messages[0].acknowledged).toBe(false);

      // 3. Acknowledge the message
      const ackResponse = await request(app)
        .post('/ack_message')
        .send({ ids: [messageId] })
        .expect(200);

      expect(ackResponse.body.success).toBe(true);
      expect(ackResponse.body.acknowledgedCount).toBe(1);

      // 4. Verify message is no longer returned (acknowledged messages are filtered out)
      const fetchAfterAckResponse = await request(app)
        .get(`/fetch_messages/${recipient}`)
        .expect(200);

      expect(fetchAfterAckResponse.body.success).toBe(true);
      expect(fetchAfterAckResponse.body.messages).toHaveLength(0);
    });

    it('should handle invalid publish message data', async () => {
      const response = await request(app)
        .post('/publish_message')
        .send({ recipient: '', content: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid request data');
    });

    it('should handle invalid ack message data', async () => {
      const response = await request(app)
        .post('/ack_message')
        .send({ ids: 'not-an-array' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid request data');
    });
  });

  describe('Resource Locking Operations', () => {
    it('should lock, renew, and unlock resources', async () => {
      const resource = 'test-resource';
      const holder = 'test-holder';
      const ttl = 30; // 30 seconds

      // 1. Lock the resource
      const lockResponse = await request(app)
        .post('/lock_resource')
        .send({ resource, holder, ttl })
        .expect(201);

      expect(lockResponse.body.success).toBe(true);
      expect(lockResponse.body.lock.resource).toBe(resource);
      expect(lockResponse.body.lock.holder).toBe(holder);
      expect(lockResponse.body.lock.ttl).toBe(ttl);

      // 2. Try to lock the same resource (should fail)
      const duplicateLockResponse = await request(app)
        .post('/lock_resource')
        .send({ resource, holder: 'another-holder', ttl: 60 })
        .expect(409);

      expect(duplicateLockResponse.body.success).toBe(false);
      expect(duplicateLockResponse.body.error).toBe('Resource is already locked');

      // 3. Renew the lock
      const renewResponse = await request(app)
        .post('/renew_lock')
        .send({ resource, ttl: 60 })
        .expect(200);

      expect(renewResponse.body.success).toBe(true);
      expect(renewResponse.body.lock.ttl).toBe(60);

      // 4. Unlock the resource
      const unlockResponse = await request(app)
        .delete(`/unlock_resource/${resource}`)
        .expect(200);

      expect(unlockResponse.body.success).toBe(true);

      // 5. Verify resource can be locked again
      const relockResponse = await request(app)
        .post('/lock_resource')
        .send({ resource, holder: 'new-holder', ttl: 30 })
        .expect(201);

      expect(relockResponse.body.success).toBe(true);
      expect(relockResponse.body.lock.holder).toBe('new-holder');
    });

    it('should handle invalid lock resource data', async () => {
      const response = await request(app)
        .post('/lock_resource')
        .send({ resource: '', holder: '', ttl: -1 })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid request data');
    });

    it('should handle renewing non-existent lock', async () => {
      const response = await request(app)
        .post('/renew_lock')
        .send({ resource: 'non-existent-resource', ttl: 30 })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Lock not found');
    });

    it('should handle unlocking non-existent resource', async () => {
      const response = await request(app)
        .delete('/unlock_resource/non-existent-resource')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Lock not found');
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Agent-Bridge server is running');
      expect(response.body.timestamp).toBeDefined();
    });
  });
});