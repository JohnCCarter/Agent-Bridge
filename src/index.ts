﻿import express, { Request, Response } from 'express';
import { z } from 'zod';
import {
  contractCreateSchema,
  contractUpdateSchema,
  createContract,
  getContract,
  updateContract,
  serializeContract,
  attachMessageToContract
} from './contracts';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});

interface Message {
  id: string;
  recipient: string;
  content: string;
  timestamp: Date;
  acknowledged: boolean;
  sender?: string;
  contractId?: string;
}

interface ResourceLock {
  resource: string;
  holder: string;
  ttl: number;
  createdAt: Date;
}

interface BridgeEvent {
  id: string;
  type: string;
  timestamp: string;
  data: unknown;
}

const messages: Message[] = [];
const locks: Map<string, ResourceLock> = new Map();
const eventClients = new Set<Response>();
const eventHistory: BridgeEvent[] = [];
const EVENT_HISTORY_LIMIT = 100;

const publishMessageSchema = z.object({
  recipient: z.string().min(1),
  content: z.string().min(1),
  sender: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
  contract: contractCreateSchema.optional()
}).superRefine((data, ctx) => {
  if (data.contract && data.contractId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either contract or contractId, not both',
      path: ['contract']
    });
  }
});

const ackMessageSchema = z.object({
  ids: z.array(z.string())
});

const lockResourceSchema = z.object({
  resource: z.string().min(1),
  holder: z.string().min(1),
  ttl: z.number().positive()
});

const renewLockSchema = z.object({
  resource: z.string().min(1),
  ttl: z.number().positive()
});

const contractIdParamSchema = z.object({
  id: z.string().min(1)
});

function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function isLockExpired(lock: ResourceLock): boolean {
  const now = Date.now();
  const expiresAt = lock.createdAt.getTime() + (lock.ttl * 1000);
  return now > expiresAt;
}

function cleanExpiredLocks(): void {
  for (const [resource, lock] of locks.entries()) {
    if (isLockExpired(lock)) {
      locks.delete(resource);
      pushEvent('lock.expired', {
        resource,
        holder: lock.holder
      });
    }
  }
}

function pushEvent(type: string, data: unknown): void {
  const event: BridgeEvent = {
    id: generateId(),
    type,
    timestamp: new Date().toISOString(),
    data
  };

  eventHistory.push(event);
  if (eventHistory.length > EVENT_HISTORY_LIMIT) {
    eventHistory.shift();
  }

  const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    client.write(payload);
  }
}

function sendEventHistory(res: Response): void {
  for (const event of eventHistory) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sendEventHistory(res);
  eventClients.add(res);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

app.post('/publish_message', (req: Request, res: Response) => {
  try {
    const { recipient, content, sender, contractId, contract } = publishMessageSchema.parse(req.body);

    if (contractId) {
      const existingContract = getContract(contractId);
      if (!existingContract) {
        return res.status(404).json({
          success: false,
          error: 'Contract not found'
        });
      }
    }

    let createdContract: ReturnType<typeof createContract> | undefined;
    let resolvedContractId = contractId;

    if (contract) {
      createdContract = createContract(contract);
      resolvedContractId = createdContract.id;
      pushEvent('contract.created', {
        contract: serializeContract(createdContract)
      });
    }

    const message: Message = {
      id: generateId(),
      recipient,
      content,
      timestamp: new Date(),
      acknowledged: false,
      sender,
      contractId: resolvedContractId
    };

    messages.push(message);

    if (resolvedContractId) {
      attachMessageToContract(resolvedContractId, message.id);
      pushEvent('contract.message_linked', {
        contractId: resolvedContractId,
        messageId: message.id
      });
    }

    pushEvent('message.published', {
      messageId: message.id,
      recipient,
      sender,
      contractId: resolvedContractId
    });

    const responseBody: Record<string, unknown> = {
      success: true,
      message: 'Message published successfully',
      messageId: message.id
    };

    if (resolvedContractId) {
      responseBody.contractId = resolvedContractId;
    }

    if (createdContract) {
      responseBody.contract = serializeContract(createdContract);
    }

    res.status(201).json(responseBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.get('/fetch_messages/:recipient', (req: Request, res: Response) => {
  try {
    const { recipient } = req.params;

    if (!recipient) {
      return res.status(400).json({
        success: false,
        error: 'Recipient parameter is required'
      });
    }

    const recipientMessages = messages.filter(m =>
      m.recipient === recipient && !m.acknowledged
    );

    res.json({
      success: true,
      messages: recipientMessages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

app.post('/ack_message', (req: Request, res: Response) => {
  try {
    const { ids } = ackMessageSchema.parse(req.body);

    let acknowledgedCount = 0;
    ids.forEach(id => {
      const message = messages.find(m => m.id === id);
      if (message && !message.acknowledged) {
        message.acknowledged = true;
        acknowledgedCount++;
        pushEvent('message.acknowledged', { messageId: message.id, recipient: message.recipient });
      }
    });

    res.json({
      success: true,
      message: `${acknowledgedCount} messages acknowledged`,
      acknowledgedCount
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.post('/contracts', (req: Request, res: Response) => {
  try {
    const payload = contractCreateSchema.parse(req.body);
    const contract = createContract(payload);
    const serialized = serializeContract(contract);
    pushEvent('contract.created', { contract: serialized });
    res.status(201).json({
      success: true,
      contract: serialized
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.get('/contracts/:id', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const contract = getContract(id);

    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    res.json({
      success: true,
      contract: serializeContract(contract)
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.patch('/contracts/:id/status', (req: Request, res: Response) => {
  try {
    const { id } = contractIdParamSchema.parse(req.params);
    const payload = contractUpdateSchema.parse(req.body);

    const updatedContract = updateContract(id, payload);
    if (!updatedContract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    const serialized = serializeContract(updatedContract);
    pushEvent('contract.updated', {
      contract: serialized,
      actor: payload.actor,
      note: payload.note
    });

    res.json({
      success: true,
      contract: serialized
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.post('/lock_resource', (req: Request, res: Response) => {
  try {
    const { resource, holder, ttl } = lockResourceSchema.parse(req.body);

    cleanExpiredLocks();

    if (locks.has(resource)) {
      return res.status(409).json({
        success: false,
        error: 'Resource is already locked'
      });
    }

    const lock: ResourceLock = {
      resource,
      holder,
      ttl,
      createdAt: new Date()
    };

    locks.set(resource, lock);

    pushEvent('lock.created', {
      resource,
      holder,
      ttl,
      expiresAt: new Date(lock.createdAt.getTime() + (lock.ttl * 1000)).toISOString()
    });

    res.status(201).json({
      success: true,
      message: 'Resource locked successfully',
      lock: {
        resource: lock.resource,
        holder: lock.holder,
        ttl: lock.ttl,
        expiresAt: new Date(lock.createdAt.getTime() + (lock.ttl * 1000))
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.post('/renew_lock', (req: Request, res: Response) => {
  try {
    const { resource, ttl } = renewLockSchema.parse(req.body);

    cleanExpiredLocks();

    const existingLock = locks.get(resource);
    if (!existingLock) {
      return res.status(404).json({
        success: false,
        error: 'Lock not found'
      });
    }

    if (isLockExpired(existingLock)) {
      locks.delete(resource);
      pushEvent('lock.expired', {
        resource,
        holder: existingLock.holder
      });
      return res.status(410).json({
        success: false,
        error: 'Lock has expired'
      });
    }

    existingLock.ttl = ttl;
    existingLock.createdAt = new Date();

    pushEvent('lock.renewed', {
      resource,
      holder: existingLock.holder,
      ttl,
      expiresAt: new Date(existingLock.createdAt.getTime() + (existingLock.ttl * 1000)).toISOString()
    });

    res.json({
      success: true,
      message: 'Lock renewed successfully',
      lock: {
        resource: existingLock.resource,
        holder: existingLock.holder,
        ttl: existingLock.ttl,
        expiresAt: new Date(existingLock.createdAt.getTime() + (existingLock.ttl * 1000))
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
});

app.delete('/unlock_resource/:resource', (req: Request, res: Response) => {
  try {
    const { resource } = req.params;

    if (!resource) {
      return res.status(400).json({
        success: false,
        error: 'Resource parameter is required'
      });
    }

    cleanExpiredLocks();

    const existingLock = locks.get(resource);
    if (!existingLock) {
      return res.status(404).json({
        success: false,
        error: 'Lock not found'
      });
    }

    locks.delete(resource);

    pushEvent('lock.released', {
      resource,
      holder: existingLock.holder
    });

    res.json({
      success: true,
      message: 'Resource unlocked successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Agent-Bridge server is running',
    timestamp: new Date().toISOString()
  });
});

export function clearEventHistory(): void {
  eventHistory.length = 0;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Agent-Bridge server is running on port ${PORT}`);
  });
}

export default app;
