# @theia-shell/theia-httpeers-proxy

A Theia extension that exposes outside HTTP origins to the httpeers mesh
through this browser, and calls other members' proxies. It is the proxy demo
page of httpeers (`apps/demos/src/proxy`) as a Theia view, served through
`@theia-shell/theia-httpeers`'s `MeshContribution`.

| Contribution | What |
|---|---|
| Mount | `/proxy` on this member, advertised as `{ id: "proxy", kind: "proxy" }` while there is at least one route. Other members call `/peers/<this peer>/proxy/<prefix>/…`; `/proxy` itself lists the routes. |
| View *Mesh Proxy* (main area) | The route table (prefix, upstream, credential), a form to add one, and a test console that calls this browser's table in process, or a peer's proxy over the mesh. |
| Command | *Toggle Mesh Proxy* (also under *View*) |

**Credentials.** A route may send a credential upstream. The header's *name*
is saved with the route (in `localStorage`), and the *value* is kept in memory
for this session only. `StoredRoute` has no field for a value, and `save()`
throws if one reaches it.

**What leaves for the upstream.** The mesh's own headers (the membership
token and the proven peer, `MESH_CREDENTIAL_HEADERS`) are stripped.
`Authorization` belongs to the application and goes through, unless the route's
own credential replaces it.

**CORS.** The proxy runs in a browser page, so the upstream is fetched by
that page and must answer CORS for the app's origin.

`src/common/route-store.ts` and `proxy-upstream.ts` are ported unchanged from
httpeers' demos; an app does not import from another app. The routing (a Hono
router rebuilt when the table changes) is in `proxy-table.ts`.

Tests: `pnpm test` runs 15 unit tests (routing on segment boundaries, header
hygiene, secrets never persisted, requests re-rooted below the mount). The e2e
tests are in [`app/tests/mesh.spec.ts`](../../app/tests/mesh.spec.ts) (a member
reaches an outside origin through another member's proxy) and
[`app/tests/chat.spec.ts`](../../app/tests/chat.spec.ts).
