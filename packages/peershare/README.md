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

| Extension points | |
|---|---|
| `peershare:upstream-kinds` | keyed; `bridged` and `direct` built in (decision 4.1) |
| `peershare:sharer-mount` | the Sharer's `/s` handler, for the Feature that hosts the mesh |

## Internals

- `SharerManager` (`src/internal/sharer.manager.ts`) is the one place Services change.
  Every command waits for the stored Sharer (`ready`) before acting.
- Ports, injected: `SharerStore` (IndexedDB in the page, memory in tests), and the
  Bridge pairing, read per request.
- `src/public/suite.ts` is the slice of the sandclaw suite runtime a Feature sees (copied
  from ui-protos, see `apps/peershare-protos/12-feature-contribution`). It goes away when
  the package moves to sandclaw.
- Tests drive commands on a headless runtime (`tests/harness.ts`), against a real Bridge
  and real apps.

```sh
pnpm --filter @statewalker/peershare test
```

## License

MIT
