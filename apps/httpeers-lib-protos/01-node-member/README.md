# 01 — Does the member lifecycle run headless under Node?

`pnpm test 01-node-member`

**Answer: yes, on the production path, with three injected adapters and no
other change.** `src/member.ts`'s `startMember` is
`src/browser/peer-runtime.ts`'s `startBrowserPeer` with the browser node
factory, the ServiceWorker edge and the page-wake listener lifted into a
`MemberPlatform`. Every step of the join — `dialRelay`, `reachHub`,
`createPeer`, `resumeMembership`, `redeemInvitation`, `reserveOnHub`,
`superviseHubReservation`, `leaveRelay`, `startJoin`, `createRouteEnsurer`,
`createEdgeDispatch` — is **imported from the stack and runs unchanged**. The
rung would have failed if any of them had to be reimplemented; none did.

The hub and relay are the real ones: `tests/e2e/harness.ts`'s `startStack`
boots both from their own `main.ts` entry points with seeded on-disk keys and
the TTL sweep timer running.

## Verified

| # | Claim | How it is established | What would falsify it |
|---|---|---|---|
| 1 | A Node member joins by redeeming an invitation | `joinedBy === "redeemed"` for two independent members | The join path needing a DOM, an origin, or a ServiceWorker |
| 2 | **The edge exists under Node with no ServiceWorker** | `fetch` is a function; `baseUrl` is `undefined` | Needing a SW to have an edge at all |
| 3 | The heartbeat runs | Each member appears in the other's `meshView()` within 30 s | Presence needing a page timer |
| 4 | Advertisements reach the mesh view | The provider's `kind: "echo"` ad is found by the consumer | Discovery-by-kind being browser-only |
| 5 | **One member calls another through its own edge** | `consumer.fetch("http://member.local/peers/<provider>/echo/hi")` → `200 echo:/echo/hi` | The edge dispatch depending on a page origin |
| 6 | The token rotates and the edge picks it up per call | `token()` changes within 30 s; a call after rotation still returns 200 | A cached token, or a call that breaks on rotation |
| 7 | **A dropped hub link is restored without a restart** | Every open connection to the hub is closed; the member re-establishes it and becomes reachable again | Recovery needing a page wake event, or needing a restart |

Measured 2026-09-12, all seven pass, 8.7 s total.

## Two things the timings say

**Claim 7 recovered in 209 ms**, far below the 10 s keepalive interval. The
restoration is therefore **event-driven** — `superviseHubReservation`'s
`connection:close` listener — and not the backstop timer. That matters for the
library: a Node member needs no wake adapter *because the event path carries
it*, not because the timer is good enough. `watchWake` stays optional rather
than becoming a Node stub.

**Claim 6 took 4.2 s**, one heartbeat interval. Nothing is wrong; it is the
5 s `HEARTBEAT_INTERVAL_MS` observed from outside, and it prices any future
test that waits on a token change.

## What this rung changes about the proposed seam

1. **`MemberHandle.fetch` is the isomorphism, in one field.** The same
   `createEdgeDispatch` handler is what the ServiceWorker serves in a page and
   what a Node caller invokes directly. `baseUrl` is the platform-specific
   part, and it is optional.
2. **`rules` replaces `policies`.** `peer-runtime.ts` calls the app's
   `appRules`, baking an application vocabulary into what should be library
   code. The caller passes a built `RuleSet`.
3. **The handle must expose the libp2p node.** Not as an oversight — anything
   that observes or perturbs the transport needs it, `connectionKind` already
   is such a thing, and without it this rung's claim 7 cannot be written from
   outside the library.
4. **Listen addresses are not a platform choice.** Node and browser both listen
   on `/p2p-circuit` + `/webrtc`, because a member reserves on its hub. Only
   `tcp` is added under Node. A profile that diverged here would be testing a
   different design.

## Not covered

- **The browser half of `startMember`.** The page path is proven by the stack
  itself, but not yet through *this* function; the extraction has to run both
  against one implementation before the isomorphism claim is closed.
- **Member-to-member over WebRTC.** Node members reach each other through the
  hub route and TCP. A page-to-page hop is `browser.test.ts`'s, and is
  currently red on both branches (see the ladder README).
- **The ServiceWorker edge** — rungs 02 and 06.
- **Identity persistence.** Each member here gets a fresh key; the key-store
  adapter is rung 04's shape, not exercised here.
- **Anything about `main`'s relay-reservation model.** This rung is built on
  the merged union, where a member reserves on its hub.
