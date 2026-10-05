# @statewalker/service-http-impl

> **Experimental / internal.** Private package in `statewalker-sandbox`, scheduled for refactor. Not published to npm.

## What it is

A Node HTTP server for `@statewalker/service-http`. Its default export takes a context, serves the
context's HTTP services through Hono and `@hono/node-server`, and exposes the context's RPC
registry (`@statewalker/service-rpc`) over a WebSocket at `/rpc`.

## Why it exists

`@statewalker/service-http` defines routes without a server. This package is the one place that
picks a server library, so the modules that register routes and RPC services stay free of it.

## How to use

The package is private; inside this workspace depend on it with `"@statewalker/service-http-impl": "workspace:^"`.
Entry points: `.` (`src/index.ts`, default export only) and `./*`.

`createHttpService(context)` (the default export):

1. reads `getHttpServiceConfig(context)` (`port`, `host`, `cors`);
2. mounts `GET /rpc` as a WebSocket endpoint serving `getRpcRegistry(context)`;
3. sends every other request to `newHttpServiceDispatcher(context)`;
4. starts listening and returns `async () => void`, which stops the dispatcher and the server.

## Examples

```ts
import { provideHttpService, setHttpServiceConfig } from "@statewalker/service-http";
import createHttpService from "@statewalker/service-http-impl";
import { newRpcAdapter } from "@statewalker/service-rpc";

const context: Record<string, unknown> = {};
setHttpServiceConfig(context, { port: 3000, host: "localhost" });

provideHttpService(context, { path: "/hello", fetch: () => new Response("hello") });

const [, setCalculator] = newRpcAdapter<{ add(a: number, b: number): Promise<number> }>("calculator");
setCalculator(context, { add: async (a, b) => a + b });

const shutdown = createHttpService(context);
// http://localhost:3000/hello, ws://localhost:3000/rpc
await shutdown();
```

A longer walkthrough, including clients: [WEBSOCKET_RPC_EXAMPLE.md](./WEBSOCKET_RPC_EXAMPLE.md).

## Internals

- **One RPC server per socket.** Each `/rpc` connection gets its own `createWebSocketRpcServer`
  over the whole registry; it is cleaned up on close or error.
- **CORS** is applied to all routes when the config has `cors`; the default config sets
  `origin` from `CORS_ORIGIN` (`*`).
- **What surprises.** The `start` script (`tsx watch ./src/index.ts`) only loads the module; it
  starts no server. Call the default export from your own entry point.
- **Dependencies.** `hono`, `@hono/node-server`, `@hono/node-ws`, `ws` for the server;
  `@statewalker/service-http`, `@statewalker/service-rpc`; `@statewalker/shared-adapters` and
  `@statewalker/shared-logger` for per-connection state and logging.

## License

MIT
