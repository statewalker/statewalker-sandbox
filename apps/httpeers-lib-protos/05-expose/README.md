# 05 — Are "reverse proxy" and "expose a local service" one mechanism?

`pnpm test 05-expose`

**Answer: yes. One route table, two upstream kinds, twelve scenarios written
once and passing on both platforms — except one row a browser is forbidden to
pass.**

The difference between the two features is the last step only: an in-process
handler is **called**, a URL upstream is **re-issued**. Everything before it —
longest-prefix matching on segment boundaries, path rewriting, the listing at
the mount root, the marker header, streaming — is shared, and is lifted from
`services/proxy.ts` and `services/proxy-routes.ts` rather than rewritten
(`matchRoute` is imported, not copied).

```ts
type Upstream = FetchHandler;               // a local service, a remote origin, another peer
routeTable({ routes, mountPrefix }): FetchHandler
urlUpstream({ base, headers, credential, via, fetchImpl }): Upstream
```

## Measured, 2026-09-12

| Scenario | Node | Browser |
|---|:--:|:--:|
| local handler: reached and path rewritten | ✓ | ✓ |
| url upstream: reached through the same table | ✓ | ✓ |
| url upstream: the mesh `authorization` is **not** forwarded | ✓ | ✓ |
| url upstream: the route's credential and headers are injected | ✓ | ✓ |
| **url upstream: `Via` is set** | ✓ | **✗ forbidden** |
| local handler: the caller's `authorization` **survives** | ✓ | ✓ |
| url upstream: hop-by-hop headers are removed | ✓ | ✓ |
| url upstream: a redirect is reported as a redirect | ✓ | ✓ |
| listing: prefixes listed, no credential leaks | ✓ | ✓ |
| unmatched: 404 with the proxy's own marker | ✓ | ✓ |
| matching: a shared prefix does not capture another route | ✓ | ✓ |
| url upstream: the body streams rather than buffering | ✓ | ✓ |

## What the run settles

**Hygiene belongs to the URL upstream, not to the table.** Two rows prove the
asymmetry is required: re-issuing to a third party must consume the mesh
credential, and calling a local handler must **not** strip it — a handler
inside the mesh still needs the caller's identity. Putting the stripping in
the table would break the local case; putting it nowhere leaks mesh tokens.

**`Via` cannot be set in a browser.** It is a forbidden header name under the
Fetch spec, so the browser drops it silently — no error, no warning. ADR-0015
has an intermediary announce itself with `Via`; that part is unimplementable in
a browser-hosted intermediary, and any conformance criterion asserting it must
be Node-only or dropped. This is a fact about the platform, not about the code.

**Two defects of the shipping proxy are fixed and pinned by tests:**

1. **A redirecting upstream was reported as unreachable.** With
   `redirect: "manual"`, a browser returns an opaque response with status 0,
   and `new Response(body, {status: 0})` throws — inside the `try`, so the
   catch reports `502 upstream-unreachable`. It is now `502` with
   `x-httpeers-proxy: upstream-redirect`, which names what happened.
2. **No `signal` was forwarded**, so an aborted caller left the upstream call
   running. The outbound request carries the caller's signal.

## Not covered

- **Reaching `localhost` from a browser**, which is impossible and is the
  reason "expose a local service" needs a Node host even though the library is
  isomorphic. The library is one; its *reach* is not.
- **The mesh path.** These scenarios call the table directly. Whether a mesh
  caller may reach it is policy, which rung 01 exercises end to end.
- **CORS.** The fixture is same-origin deliberately, so the browser column
  measures the route table rather than the upstream's CORS configuration.
- **Firefox and Safari**, and `credential()` refresh/rotation.
