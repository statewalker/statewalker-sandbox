# 01 — Can Direct and Bridged be one `Upstream` behind one route table?

`pnpm test 01-upstream-kinds`

**Answer: yes.** Both kinds are a `urlUpstream` from `@statewalker/webrun-http-proxy`;
Bridged only re-aims it at the Bridge and adds two headers. The Sharer's router
(`/s/<serviceId>/<path>`) never learns which kind it is calling, and every scenario
passes for both kinds with the same assertions.

```ts
type UpstreamConfig =
  | { kind: "direct"; target: string }
  | { kind: "bridged"; target: string; bridge: { base: string; token: string } };

createUpstream(config): Upstream                 // Upstream = (Request) => Promise<Response>
shareRouter({ services: () => [{ id, upstream }] }): FetchHandler
unreachable(response): "service" | "bridge" | undefined
```

## Measured, 2026-10-30 (Node 22, real ports)

| Scenario | Direct | Bridged |
|---|:--:|:--:|
| Guest request reaches the Service, path and query rewritten | ✓ | ✓ |
| Guest's mesh credentials (`x-httpeers-token`, `x-httpeers-peer`) never reach the Service; the app's `authorization` does | ✓ | ✓ |
| A Guest cannot pick the Bridge's target; no `x-peershare-*` header reaches the Service | ✓ | ✓ |
| A Guest's POST body arrives | ✓ | ✓ |
| A live response streams (first chunk held before the second exists) | ✓ | ✓ |
| "Service down" is told apart from "Bridge down" | ✓ | ✓ |

## What the rung found

1. **The Bridge wire contract** (rung 02 implements it for real):
   - request headers `x-peershare-target` (the Service's local URL, set by the Sharer)
     and `x-peershare-bridge-token` (the Pairing token); the Bridge consumes both;
   - response marker `x-peershare-bridge`: `relayed` on every relayed response,
     `target-unreachable` when the Service did not answer. The page adds
     `bridge-unreachable` itself when the Bridge did not answer.
2. **Direct leaked the Bridge headers.** A Guest could send `x-peershare-target` and
   `x-peershare-bridge-token` through a Direct upstream straight to the app. Both are
   now stripped for every kind, together with `MESH_CREDENTIAL_HEADERS`. Bridged was
   already safe, because the configured headers override the Guest's.
3. **The first Bridged test passed with no Bridge code.** In Node the Service is
   reachable directly, so a "bridged" upstream that skipped the Bridge passed too.
   The `relayed` marker is what lets a test, and later the Probe, see the path taken.
4. **The router dropped request bodies.** A rewritten `Request` needs its body passed
   on explicitly, through `bodyOf` (Firefox has no `Request.body`).
5. **The Bridge must drop hop-by-hop headers.** The stand-in Bridge copied
   `transfer-encoding: chunked` into its own `fetch`, and undici refused every streamed
   POST, which surfaced as `target-unreachable`. Added to rung 02.
6. **The streaming test is a guard.** It passed on its first run. It was then checked
   against a buffering Bridge, which made it fail in 3 s instead of hanging.

## Not answered here

- Browser behaviour: CORS on Direct, Local Network Access on Bridged (rungs 03, 08).
- Bridge lock-down (origin, token checks, loopback-only targets): rung 02. The
  stand-in in `src/fixtures.ts` is throwaway and checks only the token.
- Redirects, request cancellation (`signal`), WebSockets (rung 15).
