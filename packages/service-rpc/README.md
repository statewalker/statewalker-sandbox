# @statewalker/service-rpc

> **Experimental / internal.** Private package in `statewalker-sandbox`; not published to npm. Future uncertain.

## What it is

A small RPC layer over `MessagePort`, built on Comlink. You expose a plain object of async methods
and async generators on one port; the other port gets a typed proxy with the same shape. A bridge
carries the same protocol over a WebSocket, and a context registry lets a server publish several
named services on one socket.

## Why it exists

Comlink alone proxies async methods but does not stream: an async generator cannot cross a port.
This package adds a stream protocol on top of Comlink, so `async *method()` on the server becomes a
`for await` on the client, and async-iterable arguments stream the other way. It also sends a
service descriptor as the first message, so the client builds its proxy without any shared schema.
`@statewalker/service-http-impl` uses it to serve RPC at `/rpc`.

## How to use

The package is private; inside this workspace depend on it with `"@statewalker/service-rpc": "workspace:^"`.

| Entry | What it gives |
| --- | --- |
| `@statewalker/service-rpc` | Everything below (`src/index.ts`) |
| `@statewalker/service-rpc/<path>` | A single source module, e.g. `rpc/index`, `ws/websocket-rpc` (`./*` maps to `./src/*.ts`) |

Main exports:

| Export | Purpose |
| --- | --- |
| `exposeService(port, service)` | Serve `service` on a `MessagePort`. Sends the descriptor first. Returns a cleanup function. |
| `getServiceClient<T>(port, timeout = 5000)` | Wait for the descriptor and return `[client, close]`. |
| `bindWebSocketToPort(ws, port)` | Forward messages both ways between an open WebSocket and a `MessagePort`. Returns a cleanup function. |
| `waitForWebSocketOpen(ws, timeout = 5000)` | Resolve when the socket is open. |
| `isWebSocket(obj)`, `WS_READY_STATE`, `WebSocketLike` | Helpers that work with the browser `WebSocket` and the `ws` package. |
| `createWebSocketRpcServer(ws, service, options?)` | `bindWebSocketToPort` + `exposeService` for one connection. Options: `onConnect`, `onDisconnect`, `onError`. Returns a cleanup function. |
| `createWebSocketRpcClient<T>(ws, options?)` | `bindWebSocketToPort` + `getServiceClient`. Options: `onConnect`, `onDisconnect`, `onError`, `connectionTimeout`. Returns `[client, cleanup]`. |
| `getRpcRegistry(context)`, `removeRpcRegistry(context)` | The per-context object of named services. |
| `newRpcAdapter<T>(name)` | `[getRpc, setRpc, removeRpc]` for one named service in that registry. |
| `sendStream`, `receiveMessages`, `StreamRegistry` | The stream protocol used for async generators. |

## Examples

### Over a MessageChannel

```ts
import { exposeService, getServiceClient } from "@statewalker/service-rpc";

const service = {
  async sayHello(name: string) {
    return `Hello ${name}!`;
  },
  async *count(n: number) {
    for (let i = 0; i < n; i++) yield i;
  },
};

const { port1, port2 } = new MessageChannel();
const closeService = exposeService(port1, service);
const [client, closeClient] = await getServiceClient<typeof service>(port2);

await client.sayHello("World"); // "Hello World!"
for await (const i of client.count(3)) console.log(i); // 0, 1, 2

closeClient();
closeService();
```

### Over a WebSocket

```ts
import { WebSocketServer } from "ws";
import { createWebSocketRpcClient, createWebSocketRpcServer } from "@statewalker/service-rpc";

const calculator = {
  async add(a: number, b: number) {
    return a + b;
  },
};

// Server: one RPC server per connection.
const wss = new WebSocketServer({ port: 8080 });
wss.on("connection", (ws) => {
  const cleanup = createWebSocketRpcServer(ws, calculator);
  ws.on("close", cleanup);
});

// Client (browser WebSocket or `ws`).
const [remote, cleanup] = await createWebSocketRpcClient<typeof calculator>(
  new WebSocket("ws://localhost:8080"),
);
await remote.add(5, 3); // 8
cleanup();
```

### Named services in a context

```ts
import { getRpcRegistry, newRpcAdapter } from "@statewalker/service-rpc";

const [getCalculator, setCalculator] = newRpcAdapter<{
  add(a: number, b: number): Promise<number>;
}>("calculator");

const context = {};
setCalculator(context, { add: async (a, b) => a + b });

getRpcRegistry(context); // { calculator: { add } }: expose this object to serve every service
```

A client of a registry sees nested objects: `client.calculator.add(1, 2)`.

## Internals

### How the descriptor is built

`exposeService` walks the service object and records, for each field:

- `method`: a function. Argument names are parsed from `fn.toString()`.
- `stream`: a function whose constructor is `AsyncGenerator`, i.e. declared `async function*` or
  `async *name()`. A function that only returns an async iterator is a `method`, and its result
  does not stream.
- `object`: a nested object, described recursively.

The descriptor is posted as `{ __service_descriptor }` before Comlink takes over the port. The
client waits for it; if it does not arrive in time the call rejects with
`Timeout waiting for service descriptor`.

### Why the client binds before the socket opens

The server posts the descriptor as soon as a connection opens. With the `ws` package that message
can arrive in the same tick as `open`. `createWebSocketRpcClient` therefore binds the socket to the
port before awaiting `open`; a listener attached after `open` misses the descriptor and times out.
If you wire `bindWebSocketToPort` and `getServiceClient` by hand, keep that order.

### What breaks

- `WebSocket open timeout`, `WebSocket connection failed`, `WebSocket is closed or closing`: from
  `waitForWebSocketOpen`, also thrown by `createWebSocketRpcClient`.
- `Timeout waiting for service descriptor`: the other side never called `exposeService`, or the
  bridge was attached too late (see above).
- `bindWebSocketToPort` assumes an open socket; wait first with `waitForWebSocketOpen`.
- In Node, `MessagePort.prototype.start` is polyfilled as a no-op when missing.

### Dependencies

- `comlink`: the call protocol over `MessagePort`.
- `@statewalker/shared-generators`: `newAsyncGenerator`, used to turn incoming stream messages into
  an async iterator.

## Commands

```sh
pnpm --filter @statewalker/service-rpc test       # typecheck tests, then vitest
pnpm --filter @statewalker/service-rpc build      # tsdown
pnpm --filter @statewalker/service-rpc typecheck
```

Design notes: [TESTING.md](./TESTING.md),
[WEBSOCKET_BINDING.md](./WEBSOCKET_BINDING.md).

## License

MIT
