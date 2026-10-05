# @statewalker/httpeers.core

> **Experimental / internal.** Private package in `statewalker-sandbox`. Not published to npm.

## What it is

The core of the httpeers mesh: HTTP between peers over libp2p, where each request carries the
caller's transport-proven peer identity and a Biscuit membership token. It holds the shared
contracts (`types.ts`), membership tokens (mint and verify), the node's Datalog rules and
authorization, the hub's registries (members, presence, advertisements), revocation, a path router
(`/{peerId}/...`), and the libp2p transport adapter that assembles a running peer.

## Why it exists

The mesh apps in this repository (`apps/httpeers-stack`, the prototype ladders) need one tested
implementation of identity, tokens and routing. `packages/httpeers-conformance` measures this
package against the httpeers block API.

## How to use

Inside this workspace depend on it with `"@statewalker/httpeers.core": "workspace:^"`.
Entry points: `.` (`src/index.ts`) and `./*` (any module under `src/`, e.g.
`@statewalker/httpeers.core/tokens`).

| Module | Main exports |
| --- | --- |
| `types.ts` | `MeshClaims`, `ProvenPeer`, `ANONYMOUS`, `Remote`, `Mounts`, store contracts, `TokenRejectionReason`. Imports nothing. |
| `tokens.ts` | `generateMeshKey`, `mintToken`, `verifyToken`, `TokenVerificationError`, `warmUpTokens` |
| `rules.ts` | `ruleSet`, `DEFAULT_RULES`, `authorize`, `withPolicy`, `deriveCapabilities`, `validateRoles` |
| `store.ts` | `createMemberStore`, `createPresenceStore`, `createAdvertisementStore` |
| `revocation.ts` | `RevocationRegistry`, `RevocationCache` |
| `router.ts` | `createPeerRouter`, `createMounts` |
| `peer-handlers.ts`, `peer-context.ts` | `newPeerHandlers`, `registerPeer`, `lookupPeer`, `lookupClaims` |
| `transport-duplex.ts` | `createNode`, `serveTransport`, `createRemote`, `PROTOCOL` and default limits |
| `peer.ts` | `createPeer`: everything above wired onto one libp2p node; `DEFAULT_MINT_TTL_MS` |
| `errors.ts` | `PeerUnreachableError`, `PeerRequestTimeoutError`, `mapPeerCallError` and the other call errors |

## Examples

Mint a token at the hub and verify it at a member:

```ts
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { generateMeshKey, mintToken, verifyToken } from "@statewalker/httpeers.core";

const hubKey = await generateMeshKey();
const hub = peerIdFromPrivateKey(hubKey).toString();
const alice = peerIdFromPrivateKey(await generateMeshKey()).toString();

const token = await mintToken({ privateKey: hubKey, sub: alice, roles: ["member"], ttlMs: 60_000 });

// `connectionPeer` must be the peer the transport proved, never a value from the request.
const claims = await verifyToken(token, { issuer: hub, connectionPeer: alice });
claims.roles; // ["member"]
```

## Internals

- **Only `transport-duplex.ts` imports libp2p.** Every other module is transport-free and runs in
  any JavaScript environment.
- **Facts the node asserts never come from the token.** `verifyToken` asserts `connection_peer`
  (and `self_peer` when given) itself; a token whose subject is not the proven peer is refused with
  reason `peer-binding`. Omitting `selfPeer` fails closed: audience-scoped tokens are refused.
- **What breaks.** Refusals throw `TokenVerificationError` with a `reason` from
  `TokenRejectionReason` (`signature`, `expired`, `mesh-mismatch`, `audience`, ...) and a message
  starting `httpeers token rejected: `. `mintToken` refuses an empty `audience` array instead of
  treating it as unrestricted.
- **Dependencies.** `@statewalker/webrun-biscuit` (Biscuit tokens, pure TypeScript),
  `@libp2p/*`, `libp2p`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`,
  `@multiformats/multiaddr` (transport), `@statewalker/webrun-http-streams` and
  `@statewalker/webrun-streams-libp2p` (HTTP over libp2p streams).

```sh
pnpm --filter @statewalker/httpeers.core test
pnpm --filter @statewalker/httpeers.core typecheck
```

## License

MIT
