# @statewalker/service-http

> **Experimental / internal.** Private package in `statewalker-sandbox`, scheduled for refactor. Not published to npm.

## What it is

A transport-free HTTP routing contract. Modules register `HttpService` entries (`path`, optional
`method` and `priority`, and a `fetch(Request) => Response` handler) in a shared context object; a
dispatcher turns everything registered into one `fetch` function. The server that calls that
`fetch` lives elsewhere (`@statewalker/service-http-impl` runs it on Hono).

## Why it exists

Modules that serve HTTP should not depend on a server library or on each other. Each one only needs
the context and the standard `Request`/`Response` types; the server wiring sees a single `fetch`.
Routes are `URLPattern` path patterns, so the same handlers run in Node and in the browser.

## How to use

The package is private; inside this workspace depend on it with `"@statewalker/service-http": "workspace:^"`.
Entry points: `.` (`src/index.ts`) and `./*` (any module under `src/`, e.g.
`@statewalker/service-http/service-adapter`).

| Export | Purpose |
| --- | --- |
| `HttpService`, `DEFAULT_HTTP_SERVICE_PRIORITY` (10) | The route record and its default priority. |
| `provideHttpService(context, service)` | Register a service; returns a function that removes it. |
| `consumeHttpService`, `newHttpServiceProvider`, `removeHttpService` | The underlying service adapter (`"service:http"`). |
| `newHttpServiceDispatcher(context)` | `[fetch, remove]`: routes a `Request` to the highest-priority matching service. |
| `getHttpServiceConfig`, `setHttpServiceConfig`, `removeHttpServiceConfig`, `HttpServiceConfig` | Server config (`port`, `host`, `cors`). Defaults read `PORT` (3002), `HOST` (`0.0.0.0`), `CORS_ORIGIN` (`*`). |
| `getParamsProvider(pattern)` | Returns `(path) => params | null` for a `URLPattern` pathname such as `/users/:id`. |

## Examples

```ts
import { getParamsProvider, newHttpServiceDispatcher, provideHttpService } from "@statewalker/service-http";

const context: Record<string, unknown> = {};
const getUserParams = getParamsProvider("/users/:id");

const remove = provideHttpService(context, {
  path: "/users/:id",
  method: "GET",
  fetch: (req) => Response.json(getUserParams(new URL(req.url).pathname)),
});

const [fetch, close] = newHttpServiceDispatcher(context);
await (await fetch(new Request("http://localhost/users/42"))).json(); // { id: "42" }

remove();
close();
```

## Internals

- **Services live in the root context.** `provideHttpService` walks `context.parent` up to the
  root, so services registered from nested contexts all reach one dispatcher.
- **Matching order.** Services are sorted by `priority` (higher first, default 10); the first one
  whose method (`ALL` matches any) and `URLPattern` both match handles the request.
- **What breaks.** With no match the dispatcher answers `404` with the body
  `No handler for <METHOD> <pathname>`.
- **Dependencies.** `urlpattern-polyfill` is loaded only when `globalThis.URLPattern` is missing.
  `@statewalker/shared-adapters` provides the context adapters.

## Commands

```sh
pnpm --filter @statewalker/service-http test   # typecheck tests, then vitest
pnpm --filter @statewalker/service-http build
```

## License

MIT
