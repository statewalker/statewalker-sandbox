# @theia-shell/theia-httpeers

A Theia extension that makes the browser a member of an
[httpeers](https://github.com/statewalker/httpeers) mesh: it joins from an
invitation, shows the peers, lets an admin invite others, and gives other
extensions a place to serve on the mesh. It is browser-only (it runs the member
in the page, with its ServiceWorker edge).

| Contribution | What |
|---|---|
| `MeshService` | The app's one `PeerSession` (`createSession` from `@statewalker/httpeers-member/browser`), started with the app so a `?join=` link works on first load. It re-publishes session changes and the mesh view as Theia events, and drops a spent `?join=` from the address bar. |
| View *Mesh* (left side bar) | The join widget every httpeers page shares (`@statewalker/httpeers-join`): paste or scan an invitation, the hub link, disconnect, reconnect, leave, and for an admin the *Invite someone* panel. Below it, the peers: this browser, the hub, then the members, with roles, online state, the connection kind and what each advertises. |
| Status bar | `Mesh: live (direct)`, `Mesh: not joined`, …; clicking it toggles the view. |
| Commands | *Mesh: Join a Mesh…*, *Invite to the Mesh…* (copies the link), *Disconnect*, *Reconnect*, *Leave the Mesh (Reset Identity)…*, *Copy This Browser's Peer Id*; also under *File → Mesh ▸*. |
| `MeshContribution` | What another extension serves from this browser: `configureMounts(mounts)` runs once before the session starts, `advertisements()` is read on every heartbeat. The proxy extension is one. |

**Identity.** One member identity per origin, kept in IndexedDB by
`httpeers-member` (`keyval-store`). Two tabs of the app share it, and the
second is told so (`blocked`).

**The edge.** Peers are called with plain `fetch` to `/peers/<peerId>/…`,
which `webrun-http-browser`'s ServiceWorker routes over libp2p with the
membership token attached. The worker must be served un-hashed at `/sw.js`:
`pnpm build` copies it to `lib/sw.js` (`scripts/copy-sw.mjs`) and the app's
`esbuild.mjs` puts it at the root of `lib/frontend`. The app must be served
from the origin root, over https or from localhost.

**Rules.** `shellRules()` decides who may call what this browser serves: the
mesh protocol's capabilities, and `app:proxy.use` for every member. A
contribution serving something else adds its policy there.

**Local development.** A page on a loopback host switches on libp2p's
permissive dial gater, so it can join a mesh whose relay is on loopback too
(`tools/mesh-stack.mjs`); `?meshDev=1` does the same elsewhere.

Tests: `pnpm test` runs 8 unit tests (the peers list, the status text, the
rules). The e2e tests are in [`app/tests/mesh.spec.ts`](../../app/tests/mesh.spec.ts).
