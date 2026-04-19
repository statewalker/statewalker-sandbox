# @repo/rpc

RPC (Remote Procedure Call) service library with WebSocket support, built on Comlink and MessageChannel.

## Features

- ✅ **Type-Safe RPC** - Full TypeScript support with type inference
- ✅ **Async Methods** - Support for async functions
- ✅ **Async Generators** - Streaming data with async generators
- ✅ **WebSocket Bridge** - Connect WebSocket to MessagePort for remote RPC
- ✅ **Binary Data** - Efficient ArrayBuffer and Blob handling
- ✅ **Zero-Copy Transfers** - Transferable objects for performance
- ✅ **Comprehensive Tests** - 39 unit tests with 100% coverage

## Installation

```bash
pnpm add @repo/rpc
```

## Quick Start

### Basic RPC

```typescript
import { exposeService, getServiceClient } from '@repo/rpc';

// Define a service
const myService = {
  async sayHello(name: string) {
    return `Hello ${name}!`;
  },

  async *generateMessages(name: string, count: number) {
    for (let i = 0; i < count; i++) {
      yield `Message ${i} for ${name}`;
    }
  },
};

// Create a MessageChannel
const { port1, port2 } = new MessageChannel();

// Expose the service on port1
const [descriptor, closeService] = exposeService(port1, myService);

// Create a client from port2
const [client, closeClient] = await getServiceClient<typeof myService>(
  port2,
  descriptor,
);

// Use the client
const greeting = await client.sayHello('World'); // "Hello World!"

for await (const message of client.generateMessages('Alice', 3)) {
  console.log(message);
  // "Message 0 for Alice"
  // "Message 1 for Alice"
  // "Message 2 for Alice"
}

// Cleanup
closeClient();
closeService();
```

### RPC over WebSocket

```typescript
import { bindWebSocketToPort, exposeService, getServiceClient } from '@repo/rpc';

// Server side
const ws = new WebSocket('ws://localhost:8080');
const { port1: serverPort1, port2: serverPort2 } = new MessageChannel();
bindWebSocketToPort(ws, serverPort1);

const service = {
  async add(a: number, b: number) {
    return a + b;
  },
};

exposeService(serverPort2, service);

// Client side (in another context/process)
const clientWs = new WebSocket('ws://localhost:8080');
const { port1: clientPort1, port2: clientPort2 } = new MessageChannel();
bindWebSocketToPort(clientWs, clientPort1);

const [client] = await getServiceClient(clientPort2, descriptor);
const result = await client.add(5, 3); // 8
```

### Enhanced WebSocket Bridge

```typescript
import { createWebSocketBridge } from '@repo/rpc';

const ws = new WebSocket('ws://localhost:8080');
const { port1 } = new MessageChannel();

const { cleanup, isActive } = createWebSocketBridge(ws, port1, {
  onError: (error) => {
    console.error('Bridge error:', error);
  },
  onClose: () => {
    console.log('Bridge closed');
  },
  autoReconnect: true, // Attempt to maintain connection
});

// Check if bridge is active
if (isActive()) {
  // Bridge is operational
}

// Cleanup when done
cleanup();
```

## API Reference

### RPC Functions

#### `exposeService(port, service)`

Exposes a service object through a MessagePort.

**Parameters:**
- `port: MessagePort` - The port to expose the service on
- `service: Record<string, unknown>` - Object containing service methods

**Returns:** `[descriptor, cleanup]`
- `descriptor: Record<string, FieldDescription>` - Service descriptor
- `cleanup: () => void` - Function to close the service

#### `getServiceClient<T>(port, descriptor)`

Creates a client proxy for a remote service.

**Parameters:**
- `port: MessagePort` - The port connected to the service
- `descriptor: Record<string, FieldDescription>` - Service descriptor

**Returns:** `Promise<[client, cleanup]>`
- `client: T` - Typed client proxy
- `cleanup: () => void` - Function to close the client

#### `getServiceDescriptor(service)`

Extracts method information from a service object.

**Parameters:**
- `service: Record<string, unknown>` - Service object

**Returns:** `Record<string, FieldDescription>`
- Object mapping field names to their descriptions

### WebSocket Functions

#### `bindWebSocketToPort(ws, port)`

Binds a WebSocket to a MessagePort, creating a bidirectional bridge.

**Parameters:**
- `ws: WebSocket` - The WebSocket instance
- `port: MessagePort` - The MessagePort instance

**Returns:** `() => void` - Cleanup function

**Features:**
- Automatic JSON serialization/deserialization
- Binary data support (ArrayBuffer, Blob)
- Error handling and connection lifecycle management

#### `createWebSocketBridge(ws, port, options)`

Creates an enhanced WebSocket-to-MessagePort bridge.

**Parameters:**
- `ws: WebSocket` - The WebSocket instance
- `port: MessagePort` - The MessagePort instance
- `options: BridgeOptions` - Configuration options

**Options:**
```typescript
interface BridgeOptions {
  onError?: (error: Error) => void;
  onClose?: () => void;
  autoReconnect?: boolean;
}
```

**Returns:** `{ cleanup, isActive }`
- `cleanup: () => void` - Cleanup function
- `isActive: () => boolean` - Check if bridge is active

#### `isWebSocket(obj)`

Type guard to check if an object is a WebSocket.

**Parameters:**
- `obj: unknown` - Object to check

**Returns:** `boolean` - True if obj is a WebSocket

## Types

### FieldDescription

```typescript
interface FieldDescription {
  args: string[];              // Parameter names
  type: 'method' | 'stream' | 'object';  // Field type
}
```

- `method` - Regular async function
- `stream` - Async generator function
- `object` - Nested object containing methods/streams

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Service Object (Server)                                │
│  - async methods                                        │
│  - async generators                                     │
└──────────────────────┬──────────────────────────────────┘
                       │ exposeService()
                       ▼
┌──────────────────────────────────────────────────────────┐
│  MessagePort / WebSocket                                 │
│  - Comlink proxy                                         │
│  - Transfer handlers                                     │
└──────────────────────┬──────────────────────────────────┘
                       │ getServiceClient()
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Client Proxy (Type-Safe)                                │
│  - Mirrors service API                                   │
│  - Automatic serialization                               │
└──────────────────────────────────────────────────────────┘
```

## Advanced Usage

### Async Generator with Input

```typescript
const service = {
  async *transformStream(input: AsyncIterable<number>) {
    for await (const value of input) {
      yield value * 2;
    }
  },
};

// Client side
async function* inputNumbers() {
  yield 1;
  yield 2;
  yield 3;
}

for await (const doubled of client.transformStream(inputNumbers())) {
  console.log(doubled); // 2, 4, 6
}
```

### Error Handling

```typescript
const service = {
  async riskyOperation() {
    throw new Error('Something went wrong');
  },
};

// Client side
try {
  await client.riskyOperation();
} catch (error) {
  console.error('Remote error:', error);
}
```

### Complex Data Types

```typescript
const service = {
  async processData(data: { id: number; items: string[] }) {
    return {
      processed: true,
      count: data.items.length,
    };
  },
};

const result = await client.processData({
  id: 123,
  items: ['a', 'b', 'c'],
});
// { processed: true, count: 3 }
```

## Testing

The package includes comprehensive tests:

```bash
pnpm test
```

**Test Coverage:**
- ✅ 17 RPC tests (async methods, generators, error handling)
- ✅ 22 WebSocket binding tests (message forwarding, binary data, lifecycle)
- ✅ 39 total tests - all passing

## Performance

### Zero-Copy Transfers

ArrayBuffers are transferred without copying:
```typescript
const buffer = new ArrayBuffer(1024 * 1024); // 1MB
port.postMessage(buffer, [buffer]); // Zero-copy transfer
```

### Streaming

Async generators enable efficient streaming without buffering:
```typescript
async *streamLargeDataset() {
  for (let i = 0; i < 1000000; i++) {
    yield data[i]; // Process one at a time
  }
}
```

## Documentation

- **[TESTING.md](./TESTING.md)** - Comprehensive testing guide
- **[WEBSOCKET_BINDING.md](./WEBSOCKET_BINDING.md)** - WebSocket bridge documentation

## Dependencies

- **comlink** (^4.4.2) - Message passing foundation
- **vitest** - Testing framework (dev)

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 15+
- Node.js 18+

Requires native support for:
- MessageChannel
- WebSocket (for WebSocket features)
- Async generators

## Contributing

1. Write tests for new features
2. Follow existing code patterns
3. Keep files under 120 lines
4. Use TypeScript with strict types

## License

MIT

---

**Type-safe RPC with WebSocket support. Simple, efficient, tested.**
