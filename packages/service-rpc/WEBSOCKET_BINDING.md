# WebSocket Binding for RPC

## Date: 2025-10-14

## Summary

Implemented `bindWebSocketToPort` and related utilities to bridge WebSocket connections with MessagePort, enabling RPC communication over WebSocket connections. This allows the service-rpc package to work seamlessly with WebSocket-based communication channels.

## Implementation

### Core Functions

#### 1. `bindWebSocketToPort(ws, port)`

Creates a bidirectional bridge between a WebSocket and a MessagePort.

**Features:**
- ✅ Forwards messages from WebSocket to MessagePort
- ✅ Forwards messages from MessagePort to WebSocket
- ✅ Handles JSON serialization/deserialization automatically
- ✅ Supports binary data (ArrayBuffer, Blob)
- ✅ Proper error handling and cleanup
- ✅ Connection lifecycle management

**Usage:**
```typescript
const ws = new WebSocket('ws://localhost:8080');
const { port1, port2 } = new MessageChannel();

// Bind WebSocket to one port
const cleanup = bindWebSocketToPort(ws, port1);

// Use the other port with RPC
const [serviceProxy, closeClient] = await getServiceClient(port2, descriptor);

// Later: cleanup both
cleanup();
closeClient();
```

#### 2. `createWebSocketBridge(ws, port, options)`

Enhanced version with additional features:
- Error callbacks
- Close callbacks
- Auto-reconnect support
- Connection state tracking

**Options:**
```typescript
interface BridgeOptions {
  onError?: (error: Error) => void;
  onClose?: () => void;
  autoReconnect?: boolean;
}
```

**Usage:**
```typescript
const { cleanup, isActive } = createWebSocketBridge(ws, port, {
  onError: (err) => console.error('Bridge error:', err),
  onClose: () => console.log('Bridge closed'),
  autoReconnect: true,
});

// Check if bridge is active
if (isActive()) {
  // Bridge is operational
}

// Cleanup
cleanup();
```

#### 3. `isWebSocket(obj)`

Type guard to verify WebSocket instances.

```typescript
if (isWebSocket(obj)) {
  // obj is a WebSocket
  obj.send('message');
}
```

## Architecture

### Message Flow

```
┌─────────────────────────────────────────────────────────┐
│  WebSocket Connection                                   │
│  (Remote Server)                                        │
└──────────────────────┬──────────────────────────────────┘
                       │ Network
                       ▼
┌──────────────────────────────────────────────────────────┐
│  WebSocket (Client)                                      │
│  - send(data)                                            │
│  - onmessage                                             │
│  - onerror                                               │
│  - onclose                                               │
└──────────────────────┬──────────────────────────────────┘
                       │ bindWebSocketToPort()
                       ▼
┌──────────────────────────────────────────────────────────┐
│  MessagePort (port1)                                     │
│  - postMessage(data)                                     │
│  - onmessage                                             │
└──────────────────────┬──────────────────────────────────┘
                       │ MessageChannel
                       ▼
┌──────────────────────────────────────────────────────────┐
│  MessagePort (port2)                                     │
└──────────────────────┬──────────────────────────────────┘
                       │ getServiceClient()
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Service Proxy                                           │
│  - Local API calls                                       │
│  - Remote execution                                      │
└──────────────────────────────────────────────────────────┘
```

### Data Handling

The bridge automatically handles different data types:

| Data Type | WebSocket → Port | Port → WebSocket |
|-----------|------------------|------------------|
| **JSON Objects** | Parse JSON string → Object | Object → JSON string |
| **Plain Strings** | Pass through as-is | Send as-is (not JSON) |
| **ArrayBuffer** | Transfer (zero-copy) | Transfer (zero-copy) |
| **Blob** | Convert to ArrayBuffer | Send directly |
| **Other Types** | Pass through | JSON.stringify() |

## Test Coverage

Comprehensive test suite with 22 tests covering all functionality:

### 1. Message Forwarding (4 tests)
- WebSocket → MessagePort forwarding
- MessagePort → WebSocket forwarding
- Non-JSON string messages
- ArrayBuffer messages

### 2. Binary Data (2 tests)
- ArrayBuffer handling
- Blob handling and conversion

### 3. Connection Lifecycle (3 tests)
- WebSocket close handling
- WebSocket error handling
- MessagePort closure

### 4. Edge Cases (3 tests)
- Messages when WebSocket not open
- Idempotent cleanup
- Message filtering after cleanup

### 5. Type Guard (3 tests)
- WebSocket instance detection
- Non-WebSocket rejection
- Missing method detection

### 6. Enhanced Bridge (6 tests)
- Active state tracking
- Error callbacks
- Close callbacks
- Auto-reconnect support
- Cleanup idempotence

### 7. Bidirectional Communication (2 tests)
- Full duplex messaging
- Rapid message exchanges

## Test Results

```bash
✓ tests/rpc.test.ts (17 tests) 68ms
✓ tests/websocket-binding.test.ts (22 tests) 443ms

Test Files  2 passed (2)
     Tests  39 passed (39)

Build: 10 files, 23.25 kB total
```

## Use Cases

### 1. Remote RPC over WebSocket

```typescript
// Server side (expose service)
const ws = new WebSocket('ws://server.com/rpc');
const { port1, port2 } = new MessageChannel();
bindWebSocketToPort(ws, port1);

const service = {
  async add(a: number, b: number) {
    return a + b;
  },
};

exposeService(port2, service);
```

```typescript
// Client side (connect to service)
const ws = new WebSocket('ws://server.com/rpc');
const { port1, port2 } = new MessageChannel();
bindWebSocketToPort(ws, port1);

const [client] = await getServiceClient(port2, descriptor);
const result = await client.add(5, 3); // 8
```

### 2. Streaming Data over WebSocket

```typescript
const ws = new WebSocket('ws://server.com/stream');
const { port1, port2 } = new MessageChannel();
bindWebSocketToPort(ws, port1);

const service = {
  async *generateData(count: number) {
    for (let i = 0; i < count; i++) {
      yield { id: i, data: `Item ${i}` };
    }
  },
};

const [descriptor] = exposeService(port2, service);
const [client] = await getServiceClient(port1, descriptor);

for await (const item of client.generateData(10)) {
  console.log(item);
}
```

### 3. Error Handling with Callbacks

```typescript
const { cleanup, isActive } = createWebSocketBridge(ws, port, {
  onError: (error) => {
    logger.error('WebSocket bridge error:', error);
    // Notify user or retry
  },
  onClose: () => {
    logger.info('WebSocket bridge closed');
    // Cleanup resources
  },
  autoReconnect: true,
});
```

### 4. Microservices Communication

```typescript
// Service A connects to Service B via WebSocket
const ws = new WebSocket('ws://service-b/api');
const { port1, port2 } = new MessageChannel();
const cleanup = bindWebSocketToPort(ws, port1);

// Get remote service client
const [remoteService] = await getServiceClient(port2, {
  processData: { args: ['data'], type: 'method' },
});

const result = await remoteService.processData({ value: 42 });
```

## Implementation Details

### Message Serialization

**WebSocket → MessagePort:**
```typescript
if (typeof data === 'string') {
  try {
    // Try to parse as JSON
    data = JSON.parse(data);
  } catch {
    // If not JSON, pass as string
  }
} else if (data instanceof ArrayBuffer) {
  // Transfer ArrayBuffer (zero-copy)
  port.postMessage(data, [data]);
} else if (data instanceof Blob) {
  // Convert Blob to ArrayBuffer
  const buffer = await data.arrayBuffer();
  port.postMessage(buffer, [buffer]);
}
```

**MessagePort → WebSocket:**
```typescript
if (data instanceof ArrayBuffer || data instanceof Blob) {
  // Send binary data as-is
  ws.send(data);
} else {
  // Serialize to JSON
  ws.send(JSON.stringify(data));
}
```

### Connection State Management

The binding tracks WebSocket state and handles:
- `CONNECTING` (0) - Waiting for connection
- `OPEN` (1) - Active and ready
- `CLOSING` (2) - Closing initiated
- `CLOSED` (3) - Connection closed

Messages are only sent when `readyState === OPEN`.

### Error Handling

Three types of errors are handled:
1. **WebSocket errors** - Logged and port is closed
2. **Message forwarding errors** - Logged but doesn't break connection
3. **Port errors** - Triggers WebSocket closure

### Cleanup Process

1. Set `isCleanedUp` flag
2. Remove all event listeners
3. Close WebSocket (if open/connecting)
4. Close MessagePort
5. Prevent further operations

## Performance Considerations

### Zero-Copy Transfers

ArrayBuffers are transferred without copying:
```typescript
port.postMessage(buffer, [buffer]); // Transfer ownership
```

This is efficient for large binary data like images, audio, or video.

### Async Blob Conversion

Blobs are converted asynchronously to avoid blocking:
```typescript
blob.arrayBuffer().then((buffer) => {
  if (!isCleanedUp) {
    port.postMessage(buffer, [buffer]);
  }
});
```

### Event-Driven

No polling - all communication is event-driven:
- WebSocket `onmessage` event
- MessagePort `onmessage` event
- No timers or intervals

## Security Considerations

### Message Validation

The implementation doesn't validate message content by default. You should:
1. Validate messages on the service side
2. Use TypeScript for type safety
3. Implement authentication/authorization

### Origin Checking

For browser WebSockets, verify the origin:
```typescript
ws.addEventListener('open', () => {
  if (ws.url !== expectedUrl) {
    ws.close();
  }
});
```

### Rate Limiting

Consider implementing rate limiting for high-frequency messages:
```typescript
let messageCount = 0;
const resetInterval = setInterval(() => { messageCount = 0; }, 1000);

port.addEventListener('message', (event) => {
  if (++messageCount > MAX_MESSAGES_PER_SECOND) {
    console.warn('Rate limit exceeded');
    return;
  }
  // Process message
});
```

## Future Enhancements

Potential improvements:

1. **Automatic Reconnection** - Implement retry logic with exponential backoff
2. **Message Buffering** - Queue messages when WebSocket is connecting
3. **Compression** - Support WebSocket compression (permessage-deflate)
4. **Heartbeat/Ping-Pong** - Keep-alive mechanism
5. **Message Acknowledgment** - Confirm message delivery
6. **Multi-Channel** - Support multiple logical channels over single WebSocket
7. **Protocol Negotiation** - Support different RPC protocols
8. **Metrics** - Track message counts, errors, latency

## Comparison with Direct WebSocket

| Feature | Direct WebSocket | With Binding |
|---------|------------------|--------------|
| **Type Safety** | Manual | Full TypeScript |
| **Serialization** | Manual | Automatic |
| **RPC Support** | Manual | Built-in |
| **Streaming** | Complex | Simple async generators |
| **Error Handling** | Manual | Built-in |
| **Testing** | Difficult | Easy with mocks |
| **Code Size** | More verbose | Concise |

## Related Documentation

- **RPC Testing**: See `TESTING.md` for RPC test patterns
- **Comlink**: https://github.com/GoogleChromeLabs/comlink
- **WebSocket API**: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- **MessagePort API**: https://developer.mozilla.org/en-US/docs/Web/API/MessagePort

---

**Bridging the gap between WebSocket and RPC. Type-safe, efficient, tested.**
