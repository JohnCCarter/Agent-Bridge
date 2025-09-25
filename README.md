# Agent-Bridge

A minimal Node.js + TypeScript MCP (Message Control Protocol) server with Express for message passing and resource locking.

## Features

- **Message Operations**:
  - `publish_message`: Store messages in memory with recipient targeting
  - `fetch_messages`: Retrieve unacknowledged messages for a specific recipient
  - `ack_message`: Acknowledge messages by their IDs

- **Resource Locking Operations**:
  - `lock_resource`: Lock resources with holder identification and TTL
  - `renew_lock`: Extend lock duration 
  - `unlock_resource`: Release resource locks

- **Built with**: Express.js, TypeScript, Zod validation, Jest testing

## Quick Start

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The server will start on port 3000 (or the port specified in the `PORT` environment variable).

### Production

```bash
npm run build
npm start
```

### Testing

```bash
npm test
```

For watch mode during development:
```bash
npm run test:watch
```

## API Endpoints

### Message Operations

#### POST /publish_message
Publish a message to in-memory storage.

**Request Body:**
```json
{
  "recipient": "user123",
  "content": "Hello, world!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message published successfully",
  "messageId": "abc123def456"
}
```

#### GET /fetch_messages/:recipient
Fetch unacknowledged messages for a recipient.

**Response:**
```json
{
  "success": true,
  "messages": [
    {
      "id": "abc123def456",
      "recipient": "user123",
      "content": "Hello, world!",
      "timestamp": "2024-01-01T12:00:00.000Z",
      "acknowledged": false
    }
  ]
}
```

#### POST /ack_message
Acknowledge messages by their IDs.

**Request Body:**
```json
{
  "ids": ["abc123def456", "xyz789ghi012"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "2 messages acknowledged",
  "acknowledgedCount": 2
}
```

### Resource Locking Operations

#### POST /lock_resource
Lock a resource with a holder and time-to-live (TTL).

**Request Body:**
```json
{
  "resource": "database-connection-1",
  "holder": "service-instance-a",
  "ttl": 300
}
```

**Response:**
```json
{
  "success": true,
  "message": "Resource locked successfully",
  "lock": {
    "resource": "database-connection-1",
    "holder": "service-instance-a",
    "ttl": 300,
    "expiresAt": "2024-01-01T12:05:00.000Z"
  }
}
```

#### POST /renew_lock
Renew an existing lock with a new TTL.

**Request Body:**
```json
{
  "resource": "database-connection-1",
  "ttl": 600
}
```

**Response:**
```json
{
  "success": true,
  "message": "Lock renewed successfully",
  "lock": {
    "resource": "database-connection-1",
    "holder": "service-instance-a",
    "ttl": 600,
    "expiresAt": "2024-01-01T12:10:00.000Z"
  }
}
```

#### DELETE /unlock_resource/:resource
Release a resource lock.

**Response:**
```json
{
  "success": true,
  "message": "Resource unlocked successfully"
}
```

### Health Check

#### GET /health
Check server status.

**Response:**
```json
{
  "success": true,
  "message": "Agent-Bridge server is running",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Development

### Project Structure

```
├── src/
│   ├── index.ts          # Main server implementation
│   └── index.test.ts     # Test suite
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── jest.config.js        # Jest testing configuration
└── README.md             # This file
```

### Technologies Used

- **Node.js & TypeScript**: Runtime and type safety
- **Express.js**: Web framework for HTTP API
- **Zod**: Schema validation for API requests
- **Jest & Supertest**: Testing framework and HTTP testing
- **ts-node**: TypeScript execution for development

## License

MIT