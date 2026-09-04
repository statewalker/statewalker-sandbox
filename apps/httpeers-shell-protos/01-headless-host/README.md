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

## Goal

**Can the shell's contribution model be assembled from the existing Statewalker
packages, or does it need its own substrate?**

### Why this rung came first

Everything provenance-blind comes before anything peer-aware. Rung 1 is the
bottom of that ordering: it is where the shell's *vocabulary* — context, slots,
commands, enablement — either exists or does not. Every rung above it is a
renderer, a host or a transport for contributions that this rung defines. If the
vocabulary is wrong here, it is wrong in nine places later.

What a positive answer unblocked:

- **The whole ladder above it.** Rungs 2 and 3 render menus, palettes and
  dialogs *from* this contribution model; rung 4 persists a layout of views
  declared through `viewsSlot`; rung 6 mounts apps arriving from peers into the
  same buses. None of them has a substrate to build on if this rung fails.
- **The static-manifest plan.** The registration/render split proven here — a
  contribution is registered once and unconditionally, and `when` is evaluated
  at render time — is the mechanism that lets a build-time-generated manifest
  behave dynamically at runtime. Without it, manifests are a dead end and
  applications must imperatively add and remove entries as state changes.
- **The AI integration path.** Because a command declaration carries a schema,
  one declaration yields a menu entry, a validated invocation, an OpenAPI
  operation and an MCP tool. That is only free if commands are the invocation
  mechanism, which is a decision made here.

What a negative answer would have invalidated: a bespoke registry, bus and
adapter layer would have had to be designed, written, tested and maintained
before rung 2 could start — and `@statewalker/shared-*` would have been
revealed as the wrong foundation for the shell, which is a much larger claim
than one prototype was scoped to make.

Two collateral results changed the plan rather than merely confirming it. **Rung
5's property arrived at rung 1** — cross-app contribution by string key works
because the mechanism is inherent to string-keyed commands, not something to be
built — so prototype 5 as originally scoped became redundant. And the
**schema-URI compatibility model was dropped**: the command key is already the
shared identifier and `inputJsonSchema` already the contract, so a separate URI
registry had nothing left to do.

## Findings

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

### Verified

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

## Techniques and APIs

Enough to work with the rung without reading every file.

### The exported surface

**`src/context.ts`** — the ambient-service layer.

```ts
interface HostContext { parent?: HostContext; [key: string]: unknown }
interface AppIdentity { readonly id: string; readonly origin: string }

newShellContext(): HostContext
newAppContext(parent: HostContext, app: AppIdentity): HostContext
```

Five adapter pairs, each `[get, set]`. The getter's real signature is
`(ctx: HostContext, optional?: boolean) => T` — the second parameter suppresses
the throw and is not mentioned in the API reference, but it is there and it is
how a caller asks "is this service present?" without a `try`.

| Accessor | Key | Type | Scope |
|---|---|---|---|
| `getCommands` / `setCommands` | `shell:commands` | `Commands` | shell, inherited |
| `getRegistry` / `setRegistry` | `shell:registry` | `CommandsRegistry` | shell, inherited |
| `getSlots` / `setSlots` | `shell:slots` | `Slots` | shell, inherited |
| `getEnablement` / `setEnablement` | `shell:enablement` | `Enablement` | shell, inherited |
| `getApp` / `setApp` | `shell:app` | `AppIdentity` | app-local, does not leak up |

**`src/slots.ts`** — the four contribution types (`MenuItem`, `View`,
`StatusItem`, `Keybinding`) and their declarations: `menuItemsSlot`
(`shell:menu-items`, plain), `viewsSlot` (`shell:views`, **keyed**),
`statusItemsSlot` (`shell:status-items`, plain), `keybindingsSlot`
(`shell:keybindings`, plain).

**`src/menu.ts`** — `resolveMenu(ctx: HostContext, location: string): MenuItem[]`.

**`src/enablement.ts`** — `Fact`, `Enablement`,
`fact(predicate, ...terms): Fact`, `factSetEnablement(initial?): Enablement`.

**`src/commands.ts`** — `NotifyCommand`, `OpenDialogCommand`, `OpenViewCommand`,
`ShowPaletteCommand`, and `shellCommands` (a frozen array of the four, shaped to
spread straight into `CommandsRegistry.create(...)`).

**`src/projection.ts`** —

```ts
type ProjectionMode = "tool" | "ui-only" | "hazardous";
type ProjectionPolicy = Readonly<Record<string, ProjectionMode>>;

projectToTools(registry, policy, opts?: { includeHazardous?: boolean }): Promise<ProjectedTool[]>
projectToOpenApi(registry, policy, info: { title: string; version: string }): Promise<Record<string, unknown>>
commandKeyFromToolName(name: string): string
```

Both projections are async because `inputJsonSchema` is a lazily-derived
Promise: the bridge package loads schema-vendor adapters by dynamic import.

### How the three packages are actually used

This is the concrete form of "assembled, not built" — what each package
supplies, and how little sits on top of it.

**`@statewalker/shared-adapters` supplies the entire context mechanism.** One
function, used five times:

```ts
newAdapter<T, P>(key, create?, getParent?): [get, set, remove]
```

Its default `getParent` walks `.parent`. That single default is the whole of
parent-chain inheritance — an app reading `shell:commands` climbs to the shell
and receives the *same bus instance*, with no code here to make it happen. The
app-local scope is the same function with the default overridden:

```ts
const [getCommands, setCommands] = newAdapter<Commands, HostContext>("shell:commands");
const [getApp, setApp] = newAdapter<AppIdentity, HostContext>("shell:app", undefined, () => undefined);
```

`getParent: () => undefined` is the *only* difference between a service that
inherits and an identity that does not leak upward. Passing no `create` is what
makes an unset adapter throw `Adapter not found: {key}` instead of
fabricating one.

**`@statewalker/shared-commands` supplies declaration, dispatch and the
catalogue.** The builder is policy-first and staged — `.input` before `.output`
before `.build()` — and returns a frozen declaration carrying both Standard
Schemas and their derived JSON Schemas:

```ts
Command.async(key) | .required(key) | .silent(key) | .custom(key, policy)
  .input(schema).output(schema).label(s).description(s).icon(s).build()
```

Policies are the failure modes, and choosing one is a design decision, not a
detail: `required` rejects both when no listener is registered and when every
listener merely observed; `async` rejects only the first and waits on the
second; `silent` waits on both, which is why `shell:palette:show` with no
handler stays pending rather than erroring.

Dispatch: `commands.listen(decl, fn, { priority? })` returns a disposer, and
`commands.call(decl, payload)` returns a `Command<P, R>` with `.promise`,
`.resolve`, `.reject` and `.settled`. Listeners run priority-descending then
registration order; the `priority` option exists and this rung does not use it.
Failures arrive as a `CommandError` discriminated by `.kind` —
`input-validation`, `no-handlers`, `not-claimed`, `listener-threw`,
`output-validation`. Pending-forever is deliberately *not* a `CommandError`.

The listener contract is the sharp edge:

| Return | Meaning |
|---|---|
| `void` / `undefined` | observe only, does not claim |
| `true` | claim now, settle later via `cmd.resolve()` — the dialog form |
| `Promise<R>` | claim, settle when it resolves |

A plain object return **does not claim**. See Lessons learned.

`CommandsRegistry` is the catalogue, and its views are the capability model:

```ts
CommandsRegistry.create(...decls)           // mutable; .set / .remove
CommandsRegistry.compose(...sources)        // union, first-match-wins
CommandsRegistry.filter(source, predicate)  // the capability gate
CommandsRegistry.namespace(source, prefix)  // how a peer's commands mount
```

`filter` and `namespace` are read-only views, not copies, so a restricted
registry and the tool list projected from it are the same mechanism rather than
two enforcement paths.

**`@statewalker/shared-slots` supplies the extension points.** Declarations are
branded by kind, so the bus methods are not interchangeable and the compiler
says so:

```ts
defineSlot<MenuItem>("shell:menu-items")   // plain: provide / observe / getSnapshot
defineKeyedSlot<View>("shell:views")       // keyed:  register / get / observe / getSnapshot
```

Plain slots accumulate and are reference-deduped; `provide` returns a disposer.
Keyed slots are id-addressed, throw `RangeError` on a colliding id with a
different value, and ref-count a re-registration of the same reference.
`observe` fires synchronously once with the current snapshot before it returns.

What is left for this rung to write is only: the `when` evaluator, the menu
ordering, and the projection.

### The `when`-clause grammar

Confined to what translates cleanly to Datalog — conjunctions of positive or
negated ground facts:

```
clause := atom { "," atom }
atom   := [ "!" ] predicate "(" [ term { "," term } ] ")"
term   := quoted-string | number | "true" | "false"
```

An absent or empty clause is always enabled. Facts are matched by canonical
string form, with strings quoted and numbers and booleans bare, so
`fact("tabs", 3)` is `tabs(3)` and never matches `tabs("3")`. The comma is
depth- and quote-aware: `right("peer1", "read")` is one atom, not two.

Everything else throws `Malformed when clause` — `||`, `&&`, `==`, `!=`, `>=`,
`<=`, `>`, `<`, and `$` for variables are rejected outside quoted strings, and a
bare VS Code-style context key such as `explorerFocus` fails for want of a
predicate. Needing any of them is the signal to bring in the real engine, not to
grow the stub into a second policy language. `factSetEnablement` is the stub;
the Biscuit-backed implementation satisfies the same interface, which is why
`Enablement` is an interface at all.

### Zod in command declarations

```ts
export const NotifyCommand = Command.async("shell:notify")
  .input(z.object({
    message: z.string(),
    severity: z.enum(["info", "warning", "error"]).optional(),
    timeoutMs: z.int().positive().optional(),
  }))
  .output(z.object({ id: z.string() }))
  .label("Notify")
  .description("Show a transient notification to the user.")
  .build();
```

Three rules, each of which costs something if broken:

- **`.optional()`, never `.default()`.** Defaults are applied inside the
  handler. See Lessons learned.
- **`z.record()` takes two arguments** in Zod 4 — key schema and value schema.
  The package READMEs still show the one-argument Zod 3 form.
- **Schemas must be serialisable.** A command taking a `Blob` or a DOM node
  cannot be constructed by an agent, which is what `ProjectionMode` exists to
  express and why `OpenDialogCommand.surface` — a permissive record pending the
  A2UI catalogue — is `ui-only`.

Useful derivations, all asserted in `projection.test.ts`: `z.int().positive()`
becomes `{ type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 }`,
`z.string().nullable()` becomes `{ type: ["string", "null"] }`, and a plain
`z.object` emits `additionalProperties: false` under a
`https://json-schema.org/draft/2020-12/schema` header.

### The projection shape

A tool descriptor, with `:` replaced by `__` because several MCP clients reject
colons in a name — the transformation round-trips through
`commandKeyFromToolName`:

```ts
{
  name: "shell__notify",
  description: "Show a transient notification to the user.",
  inputSchema:  { /* draft-2020-12 */ },
  outputSchema: { /* draft-2020-12 */ },
  mode: "tool",
}
```

An OpenAPI operation, POST because commands are actions and no REST resource
modelling is invented on top of a command bus:

```jsonc
"/commands/shell:notify": {
  "post": {
    "operationId": "shell:notify",
    "summary": "Notify",                    // from .label
    "description": "…",                     // from .description
    "x-httpeers-projection": "tool",
    "requestBody": { "required": true, "content": { "application/json": { "schema": { /* input */ } } } },
    "responses": { "200": { "content": { "application/json": { "schema": { /* output */ } } } } }
  }
}
```

The policy is a hand-written side table keyed by command key, so the shared
package needs no httpeers-specific field. Unlisted keys are `ui-only`: **deny by
default**, a command must be opted in to become agent-callable.

## Lessons learned

### From the September session — all three reproduced here

1. **A plain synchronous return does not claim a command.** Only a literal
   `true` or a thenable claims; a listener returning a plain object is silently
   treated as observe-only, and under `async` policy the call simply never
   settles. No error, no warning. This cost a five-second test timeout to
   discover originally. TypeScript *does* catch it — the listener type is
   `void | true | Promise<R>` — and reproducing the trap here required casting
   past the types, which confirms the note's account. Make listeners `async`.
2. **`.default()` inverts its own purpose.** `CommandDeclaration` types input as
   `StandardSchemaV1<P, P>` — the same type parameter on both sides — so Standard
   Schema's output type is also its input type and a Zod `.default()` makes the
   defaulted field **required for callers**. Reproduced exactly: a `.default()`
   on `severity` produces `TS2345: Property 'severity' is missing … but required`
   at the *call* site. Use `.optional()` and default in the handler.
3. **Zod 4 changed `z.record()` to require two arguments.** Reproduced:
   `TS2554: Expected 2-3 arguments, but got 1`. Trivial, but the READMEs still
   show Zod 3 examples, so it will be rediscovered.

Two design lessons worth more than the three defects:

4. **"Does anyone enumerate this?" is the decision procedure.** It is what
   assigns a feature to slots, commands or adapters, and it is why notifications
   and dialogs are commands: nobody ever needs to *list* them. Deciding which
   mechanism a feature belongs to turned out to be the whole design.
5. **The split between registration time and render time is load-bearing.**
   Contributions resolve nothing when registered — the command key is an
   unresolved string and `when` is unevaluated — and `resolveMenu` re-reads both
   on every call and caches nothing. That is precisely what lets a static
   manifest survive contact with runtime state.

### From this rebuild

6. **Signature-level notes are a viable recovery format.** `src/` was rebuilt
   from `11-Prototype 1 API Reference.md` with no source available, and every
   signature it specifies landed unchanged. The notes carried enough that the
   expensive part was re-deriving *judgement*, not API shape. Prose that records
   only conclusions would not have survived the archive going corrupt.
7. **Where the reference was not complete enough**, three gaps, each of which
   forced a decision: the `projectToOpenApi` / `hazardous` inconsistency (below),
   the sort position of a `MenuItem` with no `group`, and the container type of
   `shellCommands` — "exported together" does not say array or object; a frozen
   array was chosen because `CommandsRegistry.create` is variadic.
8. **The reference describes the destructuring, not the API.** Note 11 §1 says
   the adapters "each return `[get, set]`"; `newAdapter` actually returns a
   3-tuple `[get, set, remove]`, and `get` takes a second `optional` parameter
   that suppresses the throw. Neither is wrong about what the shell *uses*, but
   a reader rebuilding from it will under-discover the substrate.
9. **A "verified output" paragraph can be accurate and still incomplete.**
   Note 11 §6 describes `shell:notify`'s schema correctly, but omits that
   `z.int()` also emits `maximum: 9007199254740991`. Asserting deep equality
   against the note's text would have failed. The tests here assert the named
   fields with `toMatchObject` and let the rest vary.
10. **Check the checkable claims rather than inheriting them.** All three
    substrate defects above were re-derived against the installed packages
    instead of being restated. All three held — but the value is that the README
    now reports something established, not something transcribed.
11. **Confirm the checker actually sees your files.** This rung's clean
    typecheck was established by running `tsc` over an explicit file list with
    the project's compiler options. A project-level `include` that silently
    matches nothing produces a green run that proves nothing, and a passing
    build is not evidence until you know what it compiled.
12. **A test count is not a fidelity measure.** The original run reported 40
    tests; this rebuild has 85. Different suite, different granularity, same
    claims. Counting was never the thing being preserved.

### Where this rebuild had to decide something the notes did not

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
