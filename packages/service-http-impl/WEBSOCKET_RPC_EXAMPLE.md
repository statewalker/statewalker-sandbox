# WebSocket RPC Integration Example

This document demonstrates how to use the WebSocket RPC functionality exposed by the HTTP service implementation.

## Overview

The HTTP service (`@repo/service-http-impl`) automatically exposes all RPC services registered in the context over a WebSocket endpoint at `/rpc`.

## Server Setup

### 1. Register RPC Services

```typescript
import { newRpcAdapter } from '@repo/rpc';
import createHttpService from '@repo/service-http-impl';
import { setHttpServiceConfig } from '@repo/service-http';

// Create context
const context = {};

// Configure HTTP server
setHttpServiceConfig(context, {
  port: 3000,
  host: 'localhost',
});

// Register a calculator service
const [, setCalculator] = newRpcAdapter<{
  add: (a: number, b: number) => number;
  subtract: (a: number, b: number) => number;
  multiply: (a: number, b: number) => number;
}>('calculator');

setCalculator(context, {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
});

// Register a user service
const [, setUserService] = newRpcAdapter<{
  getUser: (id: string) => Promise<{ id: string; name: string }>;
  createUser: (name: string) => Promise<{ id: string; name: string }>;
}>('users');

setUserService(context, {
  getUser: async (id) => {
    // Fetch from database
    return { id, name: `User ${id}` };
  },
  createUser: async (name) => {
    const id = `user-${Date.now()}`;
    // Save to database
    return { id, name };
  },
});

// Start HTTP server (automatically starts WebSocket endpoint)
const shutdown = createHttpService(context);

console.log('HTTP server: http://localhost:3000');
console.log('WebSocket RPC: ws://localhost:3000/rpc');
```

### 2. Server Endpoints

- **HTTP**: `http://localhost:PORT/*` - Regular HTTP requests
- **WebSocket RPC**: `ws://localhost:PORT/rpc` - RPC over WebSocket

## Client Usage

### Node.js Client

```typescript
import WebSocket from 'ws';
import { createWebSocketRpcClient } from '@repo/rpc';

// Connect to WebSocket RPC endpoint
const ws = new WebSocket('ws://localhost:3000/rpc');

// Wait for connection to open
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

// Create typed RPC client
const [rpcClient, cleanup] = await createWebSocketRpcClient<{
  calculator: {
    add: (a: number, b: number) => number;
    subtract: (a: number, b: number) => number;
    multiply: (a: number, b: number) => number;
  };
  users: {
    getUser: (id: string) => Promise<{ id: string; name: string }>;
    createUser: (name: string) => Promise<{ id: string; name: string }>;
  };
}>(ws);

// Call RPC methods
const sum = await rpcClient.calculator.add(5, 3);
console.log('Sum:', sum); // 8

const product = await rpcClient.calculator.multiply(4, 7);
console.log('Product:', product); // 28

const user = await rpcClient.users.getUser('123');
console.log('User:', user); // { id: '123', name: 'User 123' }

const newUser = await rpcClient.users.createUser('Alice');
console.log('Created:', newUser); // { id: 'user-...', name: 'Alice' }

// Close connection and cleanup
cleanup();
ws.close();
```

### Browser Client

```typescript
import { createWebSocketRpcClient } from '@repo/rpc';

// Connect to WebSocket
const ws = new WebSocket('ws://localhost:3000/rpc');

// Create RPC client (waits for connection automatically)
const [rpcClient, cleanup] = await createWebSocketRpcClient<{
  calculator: {
    add: (a: number, b: number) => number;
  };
}>(ws);

// Use RPC
const result = await rpcClient.calculator.add(10, 20);
console.log(result); // 30

// Close when done
cleanup();
ws.close();
```

## Features

### 1. **Multiple Services**

All services registered via `newRpcAdapter()` are automatically exposed:

```typescript
// Register multiple services
const [, setCalc] = newRpcAdapter('calculator');
const [, setUser] = newRpcAdapter('users');
const [, setAuth] = newRpcAdapter('auth');

setCalc(context, calculatorService);
setUser(context, userService);
setAuth(context, authService);

// All available over same WebSocket connection
const client = createWebSocketRpcClient<{
  calculator: CalculatorService;
  users: UserService;
  auth: AuthService;
}>(ws);
```

### 2. **Async Methods**

Supports async/await for all RPC methods:

```typescript
type DataService = {
  fetchData: (id: string) => Promise<Data>;
  saveData: (data: Data) => Promise<void>;
};
const [, setDataService] = newRpcAdapter<DataService>('data');

setDataService(context, {
  fetchData: async (id) => {
    const data = await database.get(id);
    return data;
  },
  saveData: async (data) => {
    await database.save(data);
  },
} as DataService);
```

### 3. **Type Safety**

Full TypeScript support with type inference:

```typescript
interface CalculatorService {
  add: (a: number, b: number) => number;
  subtract: (a: number, b: number) => number;
}

const [, setCalculator] = newRpcAdapter<CalculatorService>('calculator');

// TypeScript enforces correct types
const client = createWebSocketRpcClient<{
  calculator: CalculatorService;
}>(ws);

// Type-safe calls
const result: number = await client.calculator.add(5, 3);
```

### 4. **Error Handling**

Errors are propagated from server to client:

```typescript
const [, setService] = newRpcAdapter<{
  divide: (a: number, b: number) => number;
}>('math');

setService(context, {
  divide: (a, b) => {
    if (b === 0) {
      throw new Error('Division by zero');
    }
    return a / b;
  },
});

// Client receives error
try {
  await client.math.divide(10, 0);
} catch (error) {
  console.error('RPC Error:', error.message); // "Division by zero"
}
```

### 5. **Connection Lifecycle**

```typescript
ws.on('open', () => {
  console.log('Connected to RPC server');
});

ws.on('close', () => {
  console.log('Disconnected from RPC server');
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});
```

### 6. **Concurrent Connections**

Multiple clients can connect simultaneously:

```typescript
// Server handles multiple concurrent connections
// Each connection gets its own RPC server instance
// All connections share the same RPC registry
```

## Architecture

```
┌─────────────────┐
│   HTTP Client   │
│     (fetch)     │
└────────┬────────┘
         │
         │ HTTP
         ▼
┌─────────────────┐      ┌──────────────────┐
│  Hono Server    │◄─────┤  RPC Registry    │
│  (HTTP + WS)    │      │ (from context)   │
└────────┬────────┘      └──────────────────┘
         │
         │ WebSocket
         ▼
┌─────────────────┐
│  WebSocket RPC  │
│     Client      │
└─────────────────┘
```

## Testing

### Manual Testing

1. Start the server:
```bash
pnpm start
```

2. Connect with a WebSocket client:
```bash
# Using wscat
wscat -c ws://localhost:3000/rpc

# Using websocat
websocat ws://localhost:3000/rpc
```

3. Send RPC messages (handled by Comlink protocol)

### Integration Testing

For integration tests, use actual WebSocket connections:

```typescript
import WebSocket from 'ws';
import { createWebSocketRpcClient } from '@repo/rpc';
import createHttpService from '@repo/service-http-impl';

// Setup server
const context = {};
// ... register services
const shutdown = createHttpService(context);

// Wait for server to start
await new Promise(resolve => setTimeout(resolve, 200));

// Test with real WebSocket
const ws = new WebSocket('ws://localhost:PORT/rpc');
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

// Create RPC client
const [service, cleanup] = await createWebSocketRpcClient(ws);

// Run tests
const result = await service.calculator.add(5, 3);
expect(result).toBe(8);

// Cleanup
cleanup();
ws.close();
await shutdown();
```

## Notes

- WebSocket endpoint is only available when running in a Node.js environment (not in unit tests with mocked modules)
- The RPC protocol uses Comlink under the hood for serialization
- All services are exposed on a single WebSocket connection
- Services can be added/removed dynamically via `newRpcAdapter()`
- Connection state is managed automatically by Hono's WebSocket adapter
