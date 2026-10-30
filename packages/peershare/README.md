# @statewalker/peershare

> **Experimental / internal.** Private package in `statewalker-sandbox`. Not published to npm.

## What it is

PeerShare's logic: share local HTTP services with invited Guests over an httpeers mesh. It
is a `Feature` of the SandClaw suite, driven only through commands, with extension points
for other Features. The views are `peershare-react`'s.

## How to use

```ts
import { peershare, createRuntime, AddService, ProbeService } from "@statewalker/peershare";

const rt = createRuntime();
peershare({ store, bridge: () => pairing }).contribute(rt);
await rt.commands.call(AddService, {
  name: "fooService",
  kind: "bridged",
  target: "http://localhost:5173",
}).promise;
await rt.commands.call(ProbeService, { id: "fooservice" }).promise;
```

| Commands | Since |
|---|---|
| `peershare:set-name`, `add-service`, `edit-service`, `remove-service`, `toggle-service`, `set-default`, `probe`, `get-sharer` | M1 |
| `peershare:start`, `stop`, `get-sharing` (the Sharer is the hub of its own mesh) | M2 |
| `peershare:invite`; Guest: `join`, `get-guest`, `list-shared-services` | M3 |
| `peershare:list-guests`, `revoke-guest`; Guest: `resume`, `close-session` | M5 |

| Extension points | |
|---|---|
| `peershare:upstream-kinds` | keyed; `bridged` and `direct` built in (decision 4.1) |
| `peershare:sharer-mount` | the Sharer's `/s` handler, for the Feature that hosts the mesh |
| `peershare:guest-fetch` | the Viewer's route to a Service, through the member's JS `fetch` (rung 08) |

## Internals

- `SharerManager` (`src/internal/sharer.manager.ts`) is the one place Services change.
  Every command waits for the stored Sharer (`ready`) before acting.
- Ports, injected: `SharerStore`; the Bridge pairing (read per request); and `MeshInit`,
  which carries a `MeshPlatform` (how to build the Sharer's node and a Guest's member),
  the relay addresses, the Invite page, a `KeyStore` for the Sharer's key, the hub's
  storage, and a `GuestStore` for the Guest's identity. In the page these are IndexedDB;
  `./node` ships `nodeMeshPlatform`, `memoryKeyStore` and `memoryGuestStore`.
- `SharingManager` is the Sharer on its mesh. It carries every fix the prototypes found:
  `revocation: hub.revocations`, `serveOnLimitedConnection`, `stampGuest` on `/s`, and one
  static advertisement with the catalog at `/s/`.
- `GuestManager` is the Guest. Join redeems the Invite once; `resume` uses the saved
  identity; `close-session` forgets it; a Sharer that went offline is noticed on the next
  request and cleared when it answers again.
- The M5 tests passed on their first run: the GuestManager was written whole in the M3
  cycle. They guard behaviour that already existed, not red→green slices.
- `src/public/suite.ts` is the slice of the sandclaw suite runtime a Feature sees (copied
  from ui-protos, see `apps/peershare-protos/12-feature-contribution`). It goes away when
  the package moves to sandclaw.
- Tests drive commands on a headless runtime (`tests/harness.ts`), against a real Bridge
  and real apps. From M2 on, they run on a real relay and mesh (`tests/mesh-harness.ts`),
  with Dirk and Claudia as separate runtimes with their own stores.

```sh
pnpm --filter @statewalker/peershare test
```

## License

MIT
