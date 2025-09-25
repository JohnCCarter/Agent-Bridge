const axios = require('axios');
const EventSource = require('eventsource');

const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const DEFAULT_EVENT_HEADERS = {
  'User-Agent': 'AgentBridgeClient/1.0'
};

class AgentBridgeClient {
  constructor({ baseUrl = 'http://localhost:3000', agentName, timeout = 10000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentName = agentName || 'agent';
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  normalisePriority(priority) {
    if (!priority) {
      return 'medium';
    }
    const value = String(priority).toLowerCase();
    return ALLOWED_PRIORITIES.has(value) ? value : 'medium';
  }

  async createContractFromTask({
    title,
    description,
    owner,
    priority,
    tags = [],
    files = [],
    dueAt,
    metadata
  }) {
    const payload = {
      title,
      description,
      initiator: this.agentName,
      owner,
      priority: this.normalisePriority(priority),
      tags,
      files,
      dueAt,
      metadata
    };

    const response = await this.http.post('/contracts', payload);
    return response.data.contract;
  }

  async fetchContract(contractId) {
    const response = await this.http.get(`/contracts/${contractId}`);
    return response.data.contract;
  }

  async updateContract(contractId, update) {
    const payload = {
      actor: update.actor || this.agentName
    };

    if (update.status) {
      payload.status = update.status;
    }

    if (Object.prototype.hasOwnProperty.call(update, 'owner')) {
      payload.owner = update.owner;
    }

    if (update.note) {
      payload.note = update.note;
    }

    if (update.metadata) {
      payload.metadata = update.metadata;
    }

    if (update.tags) {
      payload.tags = update.tags;
    }

    if (update.files) {
      payload.files = update.files;
    }

    if (Object.prototype.hasOwnProperty.call(update, 'dueAt')) {
      payload.dueAt = update.dueAt;
    }

    const response = await this.http.patch(`/contracts/${contractId}/status`, payload);
    return response.data.contract;
  }

  async lockResource(resource, { ttl = 120 } = {}) {
    try {
      const response = await this.http.post('/lock_resource', {
        resource,
        holder: this.agentName,
        ttl
      });
      return { success: true, lock: response.data.lock };
    } catch (error) {
      if (error.response) {
        return {
          success: false,
          status: error.response.status,
          error: error.response.data?.error || error.message
        };
      }
      return { success: false, error: error.message };
    }
  }

  async unlockResource(resource) {
    try {
      await this.http.delete(`/unlock_resource/${encodeURIComponent(resource)}`);
      return { success: true };
    } catch (error) {
      if (error.response) {
        return {
          success: false,
          status: error.response.status,
          error: error.response.data?.error || error.message
        };
      }
      return { success: false, error: error.message };
    }
  }

  async renewLock(resource, { ttl = 120 } = {}) {
    await this.http.post('/renew_lock', { resource, ttl });
  }

  async lockResources(resources = [], options = {}) {
    const acquired = [];
    const failures = [];

    for (const resource of resources) {
      const result = await this.lockResource(resource, options);
      if (result.success) {
        acquired.push(resource);
      } else if (result.status === 409) {
        failures.push({ resource, reason: 'locked' });
      } else {
        failures.push({ resource, reason: result.error || 'unknown' });
      }
    }

    return { acquired, failures };
  }

  async releaseResources(resources = []) {
    for (const resource of resources) {
      await this.unlockResource(resource);
    }
  }

  subscribeEvents({
    onEvent,
    onError,
    lastEventId,
    headers = {}
  } = {}) {
    const url = `${this.baseUrl}/events`;
    const eventSource = new EventSource(url, {
      headers: {
        ...DEFAULT_EVENT_HEADERS,
        ...headers,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {})
      }
    });

    eventSource.onmessage = (event) => {
      if (!onEvent) {
        return;
      }
      try {
        const parsed = event.data ? JSON.parse(event.data) : null;
        onEvent({
          id: event.id,
          type: event.type || 'message',
          rawEvent: event,
          payload: parsed
        });
      } catch (err) {
        if (onError) {
          onError(err);
        }
      }
    };

    eventSource.onerror = (error) => {
      if (onError) {
        onError(error);
      }
    };

    return eventSource;
  }
}

module.exports = AgentBridgeClient;
