# 01 — The contribution model was assembled, not built

`pnpm test 01-headless-host` — 85 tests, no DOM touched.

**Reconstructed, not recovered.** `09-prototype-01-headless-host.tar.gz` is
corrupt: only `package.json`, `README.md` and `rolldown.config.ts` survived, and
all of `src/` is gone. Every file in `src/` and `tests/` was rebuilt from the
signature-level references in `11-Prototype 1 API Reference.md` and
`10-Prototype 1 Functional Description.md`, and each carries a
`DERIVED-FROM-NOTE:` header naming the note and section it came from. The
original run reported 40 tests; this rebuild has 85, which is not the same suite
and should not be read as one.

## The question

**Can the shell's contribution model be assembled from the existing Statewalker
packages, or does it need its own substrate?**

## The answer

Assembled. No bespoke registry, command bus or adapter layer exists here. `src/`
is glue and vocabulary over three published packages —
`@statewalker/shared-adapters@0.1.1`, `shared-commands@0.2.1`,
`shared-slots@0.2.1` — plus three things that genuinely had to be written:
`when` evaluation, menu resolution and ordering, and the OpenAPI/MCP projection.

The design that had to be got right was not code but a taxonomy. **Slots** are
for what is contributed *and enumerated* — menu items, views, status items,
keybindings. **Commands** are for what is invoked — notify, open dialog,
everything in the palette. **Adapters** are for ambient services — the buses,
app identity, enablement. "Does anyone enumerate this?" is the test that decides,
and it is why notifications and dialogs are commands rather than slots.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A context is passed **untyped** and accessed **typed** | `newShellContext()` returns a plain `Object.prototype` object; the five `get*` adapters return `Commands`, `Slots`, `Enablement`, `CommandsRegistry`, `AppIdentity` (`context.test.ts`) | The context needs a class, or a typed read needs a cast |
| 2 | An unset adapter throws `Adapter not found: {key}`, and `undefined` counts as unset | `getCommands({})` and `getCommands({ "shell:commands": undefined })` both throw (`context.test.ts`) | A missing service resolves to `undefined` and fails later, at a distance |
| 3 | An app context inherits the **same bus instances** | `newAppContext(shell, id)` is `{ parent: shell }`; `getCommands(app) === getCommands(shell)`, and the same for slots, enablement and registry, through two links (`context.test.ts`) | An app gets its own bus and contributions are invisible to the shell |
| 4 | Identity is app-local and **does not leak upward or sideways** | `getApp(app)` returns the identity; `getApp(shell)` throws; two sibling apps read their own (`context.test.ts`) | The `shell:app` adapter walks `.parent` |
| 5 | **Provenance blindness.** `origin` is an opaque URL | An `https://apps.example.com/editor/` app and a `http://localhost:7654/peer/12D3KooWabc/editor/` app resolve the same buses by the same code path (`context.test.ts`) | Anything in the host branches on the origin string |
| 6 | Contributions register **without executing application code** | A menu item stores an unresolved `command` key and an unevaluated `when` string; registering a `View` never calls `mount` (`slots.test.ts`) | Registration resolves a key, evaluates a clause, or mounts anything |
| 7 | Plain slots accumulate in insertion order and dispose precisely | Two contributions, dispose the first, the second survives; observers see `0,1,0` (`slots.test.ts`) | A disposer removes the wrong entry, or observers are not notified |
| 8 | Keyed slots are id-addressed; `View` carries **no `id` field** | `register(viewsSlot, id, view)`; a colliding id with a different value throws `RangeError`; the same value re-registered is ref-counted (`slots.test.ts`) | Two views can silently occupy one id |
| 9 | Menu resolution orders **navigation first, groups lexicographic, `order` within a group, contribution order last** | Four ordering tests, plus one that `order` does not leak across groups (`menu.test.ts`) | Any pair swaps, or `order` is compared before the group |
| 10 | **Render-time `when`.** A contribution registered once, unconditionally, appears and disappears as facts change | `files:delete` with `when: selection("file")` is absent, present after `assert`, absent after `retract` — with no re-registration (`menu.test.ts`) | `when` is evaluated at registration time, or `resolveMenu` caches |
| 11 | **Cross-app contribution** — rung 5's property, reached at rung 1 | App A contributes into `b:toolbar` naming `b:refresh`, holding no reference to B (`menu.test.ts`) | Contribution needs an import, a handle, or a registered location |
| 12 | The `when` grammar is **conjunctions of ground facts**, comma as AND, `!` as negation | Single facts, multi-term facts (`right("peer1", "read")`), negation, numbers and booleans, and `3` ≠ `"3"` (`enablement.test.ts`) | The comma inside an argument list is read as a conjunction separator |
| 13 | Everything outside that grammar **throws** | `\|\|`, `&&`, `==`, `>`, `$peer` and a bare VS Code-style context key all throw `Malformed when clause` (`enablement.test.ts`) | The stub quietly grows into a second policy language |
| 14 | `onChange` fires **only on real change** | Re-asserting an existing fact, retracting an absent one, and `setFacts` with an identical set all fire nothing (`enablement.test.ts`) | The menu re-renders on every no-op assertion |
| 15 | The four shell commands declare the stated keys and policies | `shell:notify` async, `shell:dialog:open` and `shell:view:open` required, `shell:palette:show` silent (`commands.test.ts`) | A policy changes and a caller's failure mode changes with it |
| 16 | Dispatch is late-bound by string key across apps | App B listens, app A calls, on the shell's single bus (`commands.test.ts`) | The caller needs the callee's declaration object rather than its key |
| 17 | **A plain synchronous return does not claim.** Under `async` policy the call never settles | A listener returning `{ id }` (cast past the types, which do catch it) leaves the promise pending after 25 ms and `cmd.settled === false`; the same listener made `async` resolves (`commands.test.ts`) | A plain object starts claiming — then this test fails and the trap is gone, which is the point of asserting it |
| 18 | **`.default()` inverts its own purpose**, so every optional field is `.optional()` | A caller omits `severity` and `timeoutMs` and it typechecks; the handler applies the default; the derived schema marks only `message` required (`commands.test.ts`) | A `.default()` creeps in and `StandardSchemaV1<P, P>` makes the field required for callers |
| 19 | `silent` with no handler **stays pending by design** | The promise does not reject and does not settle; it settles once a listener claims (`commands.test.ts`) | Silent starts rejecting, and palette invocations become errors |
| 20 | Projection is **deny by default** | Unlisted and explicitly `ui-only` keys yield no tool; `shell:dialog:open` is never projected (`projection.test.ts`) | A command becomes agent-callable without being opted in |
| 21 | `hazardous` is withheld unless `includeHazardous: true` | Absent by default, present and mode-labelled when asked (`projection.test.ts`) | A consequential command appears in a default tool list |
| 22 | Tool names replace `:` with `__` and **round-trip** | `shell:dialog:open` ↔ `shell__dialog__open`, including a peer-namespaced key (`projection.test.ts`) | An MCP client's tool name cannot be mapped back to a command key |
| 23 | `shell:notify` yields the **verified output** of note 11 §6 | draft-2020-12, `message` required, `severity` an enum, `timeoutMs` an integer with `exclusiveMinimum: 0`, `additionalProperties: false` (`projection.test.ts`) | The schema derivation changes shape and an agent's arguments stop validating |
| 24 | OpenAPI emits `POST /commands/{key}` carrying `x-httpeers-projection` | Path, `operationId`, `summary` from `label`, request body and 200 response schemas (`projection.test.ts`) | The path invents REST resource modelling on top of a command bus |
| 25 | **The capability gate and the tool list are the same mechanism** | `CommandsRegistry.filter` shrinks the tool set; `namespace(remote, "peer:{id}:")` mounts a peer's commands and they project as namespaced tools (`context.test.ts`, `projection.test.ts`) | Capability enforcement needs a second path beside the registry view |

## Where this rebuild had to decide something the notes did not

- **`projectToOpenApi` and `hazardous`.** Note 11 §6 gives the function no
  `includeHazardous` option, yet says the document carries an extension "carrying
  the mode" — which is only informative if more than one mode can appear. So the
  OpenAPI document emits `tool` **and** `hazardous`, labelled; `ui-only` never
  appears; and the withhold-unless-asked rule stays where the notes put it, on
  the agent tool list. This is an inference, flagged in `src/projection.ts`.
- **Menu entries with no `group`.** The notes fix `navigation` first and
  "remaining groups lexicographic" but say nothing about `group: undefined`. It
  is treated as the empty group: below `navigation`, above every named group.
  One comparison rule instead of two.

## Not covered here

- **No manifest generator.** Declarations are hand-written, so the premise of
  the whole static-manifest design is untested — the thing `when` exists to
  serve is the thing nothing here produces.
- **No activation events.** Everything registers eagerly. Lazy loading, the
  stated motivation for the manifest approach, is unproven.
- **Views are declared but never mounted.** `mount(root, ctx)` types `root` as
  `unknown` because there is no DOM. Rung 2 must narrow it.
- **Nothing validates that a menu entry's `command` key resolves.** Asserted as
  a known hole in `menu.test.ts`, not fixed.
- **Nothing executes a projected call.** Projection produces descriptions; the
  HTTP endpoint and MCP server that dispatch onto the bus do not exist.
- **`Enablement` has no async path.** `factSetEnablement` is the stub; Biscuit's
  authorizer is sync once loaded but *loading* is async, and what happens to
  menu rendering between first paint and engine-ready is undesigned. Rung 08 is
  where that lands.
- **Keybindings are a slot that nothing consumes.**
