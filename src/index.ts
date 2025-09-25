import express, { Request, Response } from 'express';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// In-memory storage
interface Message {
  id: string;
  recipient: string;
  content: string;
  timestamp: Date;
  acknowledged: boolean;
}

interface ResourceLock {
  resource: string;
  holder: string;
  ttl: number;
  createdAt: Date;
}

const messages: Message[] = [];
const locks: Map<string, ResourceLock> = new Map();

// Validation schemas
const publishMessageSchema = z.object({
  recipient: z.string().min(1),
  content: z.string().min(1)
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

// Helper functions
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
    }
  }
}

// Routes

// POST /publish_message - Publish a message to in-memory storage
app.post('/publish_message', (req: Request, res: Response) => {
  try {
    const { recipient, content } = publishMessageSchema.parse(req.body);
    
    const message: Message = {
      id: generateId(),
      recipient,
      content,
      timestamp: new Date(),
      acknowledged: false
    };
    
    messages.push(message);
    
    res.status(201).json({
      success: true,
      message: 'Message published successfully',
      messageId: message.id
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

// GET /fetch_messages/:recipient - Fetch messages for a recipient
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

// POST /ack_message - Acknowledge messages by IDs
app.post('/ack_message', (req: Request, res: Response) => {
  try {
    const { ids } = ackMessageSchema.parse(req.body);
    
    let acknowledgedCount = 0;
    
    for (const message of messages) {
      if (ids.includes(message.id) && !message.acknowledged) {
        message.acknowledged = true;
        acknowledgedCount++;
      }
    }
    
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

// POST /lock_resource - Lock a resource with holder and TTL
app.post('/lock_resource', (req: Request, res: Response) => {
  try {
    const { resource, holder, ttl } = lockResourceSchema.parse(req.body);
    
    cleanExpiredLocks();
    
    const existingLock = locks.get(resource);
    if (existingLock && !isLockExpired(existingLock)) {
      return res.status(409).json({
        success: false,
        error: 'Resource is already locked',
        lockedBy: existingLock.holder
      });
    }
    
    const lock: ResourceLock = {
      resource,
      holder,
      ttl,
      createdAt: new Date()
    };
    
    locks.set(resource, lock);
    
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

// POST /renew_lock - Renew a lock with new TTL
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
      return res.status(410).json({
        success: false,
        error: 'Lock has expired'
      });
    }
    
    // Update the lock with new TTL and reset creation time
    existingLock.ttl = ttl;
    existingLock.createdAt = new Date();
    
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

// DELETE /unlock_resource/:resource - Unlock a resource
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

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Agent-Bridge server is running',
    timestamp: new Date().toISOString()
  });
});

// Start the server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Agent-Bridge server is running on port ${PORT}`);
  });
}

export default app;