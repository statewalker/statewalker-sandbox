# 12 — Does PeerShare plug into the suite through slots and commands only?

`pnpm test 12-feature-contribution`

**Answer: yes.** PeerShare is a `Feature`. It contributes to the suite's slots and handles
its commands, and other Features extend it through its own extension points.
Everything runs on the real `@statewalker/shared-slots` and `@statewalker/shared-commands`,
with the logic of rungs 01, 04 and 07 behind the commands.

| | |
|---|---|
| Suite slots it fills | `app:views` (Services left, Viewer centre, Guests right), `app:menu-items` |
| Commands it handles | `peershare:open-sharer`, `peershare:add-service`, `peershare:toggle-service`, `peershare:list-services` |
| Extension points it defines | `peershare:upstream-kinds` (keyed; `bridged` and `direct` built in), `peershare:sharer-mount` (the `/s` handler, for whichever Feature hosts the mesh) |

`src/suite.ts` copies the slice of sandclaw `ui-protos.app/src/app/{runtime,contracts}.ts`
(`d9b89ebd`) a Feature sees. ui-protos is an app, not a package. Views `render` to
descriptors, so the logic half is testable without React.

## Measured, 2026-10-30

- Every menu item PeerShare contributes names a command PeerShare handles.
- Views land in their zones.
- Disposing leaves no views, menu items or handled commands.
- `add-service` applies the kind's own rule: the v1 policy for `bridged`/`direct`
  (`needs-https`…), and `unknown-kind` for a kind nobody registered.
- `toggle-service` pauses a Service in the catalog.
- **Another Feature registers a third kind** (in-memory "notes", no HTTP service at all),
  and a Guest's request to PeerShare's mount is served by it.

## Not answered here

The commands for Invites, Guests and the Viewer (`peershare:invite`, `revoke-guest`, `join`,
`open`, `close-session`) follow the same pattern over rungs 05–10. They are milestones M2–M5.
