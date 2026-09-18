# P1 — lessons

Prototype **P1** (`apps/mvc-blueprint-09`): P0 with the command bus replaced by dispatch over
handlers published in slots. Status: **DONE**. Two kernel primitives are enough, and the command
semantics the benchmark uses survive intact. The kernel does not get smaller in lines. What shrinks
is the dependency surface and the bookkeeping, and two failure modes P0 left open get fixed.

## History

| Commit | What |
| --- | --- |
| `8a1200a` | copy of P0; `shared-commands` + `KernelCommands` replaced by `src/kernel/commands.ts`; bundles moved to `defineCommand` / `answer` / `call`; P0's suites pass (150 node, 24 Chromium) |
| `20941ff` | 12 dispatcher tests; the dispose test asserts the in-flight write is visible and then abandoned |
| (this) | README, LESSONS |

## What was built

- `defineCommand<P, R>(key, { policy, label })` returns a frozen **plain-slot declaration** of
  `Handler<P, R>`, plus `policy`. `answer(slots, decl, fn, { priority })` is `slots.provide(decl,
  { handle, priority })`. `call(slots, decl, payload)` reads the slot's snapshot, sorts it by
  priority, and runs the handlers until the first claim. It returns a `Call` with a typed `promise`.
- A claimed, unsettled call is a contribution to the keyed slot **`sys:calls`** until it settles.
  While the call is pending, the dispatcher also observes the command slot. If the claiming handler
  leaves, the call rejects `abandoned`.
- `KernelCommands` and `sys:commands` are gone. `KernelSlots.usage()` gains `command: boolean`. The
  coverage kit skips command slots, because handlers are dispatched, not observed.

## What worked

1. **P0's whole suite passes unchanged in substance**: 150 node tests and 24 Chromium tests. Only
   the three test files that named the old API were adapted (list below). Commit races (9), dispose
   (4) and late subscriber (3) all pass.
2. **Transient delivery survives retained handlers.** Retention in a slot is about *handlers*, not
   *calls*. `call` reads the slot at call time and keeps nothing, so a late handler never sees an
   earlier call. Tested for `required` (rejects `no-handlers`) and `silent` (resolves `undefined`,
   and the late handler got 0 calls).
3. **One bookkeeping mechanism instead of two.** P0 wrapped both buses: `KernelSlots` counted
   observers and `KernelCommands` counted listeners. P1 has only `KernelSlots`. The dispose test's
   "nothing left" is one `usage()` query, and it now also covers in-flight calls.
4. **Failures and in-flight state come from the dispatcher.** R3's "log without replay", at the
   smallest size: `sys:calls` is live state. A test derives `running` for a command from it
   (`[false, true, false]`). The dispose test sees the pending `contacts:update` in it. The
   "abandoned" outcome is written by the kernel, not by the owner. After stop, a caller no longer
   waits on an owner that is gone (P0: the promise stayed pending, or resolved after stop).
5. **R1's typed request/response is native.** `defineCommand<P, R>` types both ends, and the kernel
   correlates the call with its response through the `Call`. There is no `ref` and no reply type at
   commit sites.
6. **Handler errors reach the caller unchanged.** `shared-commands` wrapped them (`listener-threw`),
   and P0's `describeError` unwrapped them again. P1 drops both. The Contacts "Name is required"
   test is what exposed the wrapper: it failed until the wrapper was removed.
7. **Claim semantics are sharper.** In `shared-commands`, a promise-returning claimer did not stop
   later listeners. They all ran, and the first to settle won. In P1 the first claim in priority
   order stops the dispatch. Observers with a higher priority still run before it. A handler
   withdrawn by an earlier handler during a dispatch is skipped (`shared-commands` ran it from its
   snapshot), and a handler added during a dispatch is not called.

## What failed / cost

1. **The kernel grows 344 → 436 LOC (+92).** The dispatcher is 124 LOC, and it replaces a 28-LOC
   subclass of an external bus. Counting the libraries (non-blank, non-comment source), kernel plus
   buses goes **1134 → 645**: `shared-commands` is 581, `shared-slots` 209.
2. **Coverage needs to know which slots are commands.** A handler slot has contributions and no
   observer, which is exactly what "unobserved" means for an extension point. So `usage()` has to
   tell the two apart (`"policy" in decl`). One primitive does not mean one semantics: command slots
   are read by `call`, not by `observe`.
3. **The `.call(` boundary rule stopped matching.** R2 forbade `.call(` / `.listen(` in renderers.
   Free functions `call(slots, …)` / `answer(slots, …)` slipped past it until the regex was
   extended. The regex now also catches bare `call(` / `answer(`. A renderer could still reach
   commands through `slots.getSnapshot(decl)[0].handle(...)`, and the existing R2 ban on `slots.*`
   in renderers covers that.
4. **Logic LOC +19 (1758 → 1777)**, all of it from import lines that biome wrapped (`answer, call`
   in place of `getCommands`). There was no logic change.

## Tests adapted (acceptance 1)

| File | Change | Why |
| --- | --- | --- |
| `tests/support/harness.ts` | removed `commands: KernelCommands` from `Running` | no command bus |
| `tests/dispose/dispose.test.ts` | "no command has a listener" → `slots.usage()` command slots before (>5) / after (0); added: the in-flight save is in `sys:calls` before stop | one bookkeeping |
| `tests/boundaries/boundaries.test.ts` | R2 regex also matches bare `call(` / `answer(`; 2 new negative controls; the R8 control uses `defineCommand` | API shape |

Non-test changes forced by the swap: `kits/loop` `describeError` (unwrap removed) and `kits/host`
(coverage skips command slots). New: `tests/kernel/commands.test.ts`, 12 tests: typed response,
`required`/`silent` × no handler / observers only, claim, `true`-claim, priority order,
withdrawn/added during dispatch, late handler, unchanged errors, abandoned, `running` from
`sys:calls`, and usage marking.

## Files touched in bundles

11 files: 2 API modules and 9 logic bundles. **+82 / −87 lines, all mechanical**: imports,
`useFields` without `commands`, `commands.listen(d, f)` → `answer(slots, d, f)`,
`commands.call(d, p)` → `call(slots, d, p)`, and `Command.required(k).input(passthrough<P>())
.output(passthrough<R>()).build()` → `defineCommand<P, R>(k)`. **0 UI files**, 0 features/apps.

## Pros

- Two primitives. The dependency on `shared-commands` is gone, along with its transitive
  `standard-json` / `standard-schema`, with no loss the benchmark notices.
- Handlers are visible in slot snapshots, and pending calls are visible in `sys:calls`. The
  debugging surface is the one that already exists for slots.
- Clean disposal gets stronger: stopping an owner rejects its callers' pending calls.
- The dispatcher is small enough to read in one sitting (124 LOC), and its semantics are pinned by
  its own tests.

## Cons

- The kernel owns code that used to be a library (+92 LOC kernel).
- A command slot is a slot with different rules (read at call time, not observed). A newcomer must
  still learn the command rules; only the mechanism merged, not the concept.
- The following are lost from `shared-commands`: input/output validation, JSON Schema projection
  (tool/OpenAPI export), the declaration registry (`compose` / `filter` / `namespace`), the `async`
  and custom policies, `description` / `icon` metadata, and "wait" for `silent`.

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **26** (P0: 26) | concept 6 restated ("a slot of handlers; call dispatches to those present now"); kernel primitives 3 → 2; `sys:*` services 4 → 3; kernel bookkeeping classes 2 → 1 |
| Simplicity | kernel LOC / + bus libraries | **436 / 645** (P0: 344 / 1134) | `commands.ts` 124 (P0 28 + `shared-commands` 581) |
| Simplicity | LOC / files of `hello` | 80 / 2, unchanged from P0 | `hello` uses no command |
| Simplicity | Rename a todo | unchanged from P0 in shape | `todos.rename` differs only in `call(slots, …)` (4 lines) |
| Separation | boundary suite: rules / violations | **8 / 0**, 2 new negative controls | R2 extended to free `call(` / `answer(` |
| Separation | single-writer violations | 0, unchanged from P0 | suite passes |
| Separation | domain-logic hits in views | 2, unchanged from P0 | no UI file touched |
| Independence | cross-bundle edges / to API / violations | unchanged from P0 (0 violations) | graph test passes; `getCommands` edges become `answer`/`call` from `@kernel` |
| Independence | standalone runs | pass / pass | node and Chromium |
| Independence | removal runs: errors / coverage | 4 runs, 0 errors; same reports as P0 | command slots excluded from coverage |
| Composability | interactions (1)–(3) | 3/3 under React, DOM and headless | |
| Composability | files changed in Contacts for (1) | 0 | |
| Composability | second UI technology | 0 logic files, unchanged from P0 | |
| Correctness gate | contract · commit races · dispose · late · read-then-set | **green** | contract 83 + single writer 4; commits 9; dispose 4 (+ in-flight/abandon assertion); late 3; read-then-set 7 + loader 7; dispatcher 12 |

Totals: node **162** tests (P0 150 + 12), Chromium **24**. LOC: kernel 436, kits 570, API 264, logic
1777, UI 1232, tests 2514.

## Answers to the points to clarify

- **Did any command need retention?** No. Every call in the benchmark comes from a user gesture
  after activation. P0's rule "never call another bundle's command while activating" still holds,
  and nothing needed a pending call delivered to a late handler. Retention would be a bug here: a
  `todos:add` retained until an owner arrives would replay a user's gesture into a later session. The
  only retained things are the handlers, plus the *in-flight* record in `sys:calls`, which is
  observable state and is never delivered.
- **Debugging: easier or harder?** Easier. `slots.getSnapshot(todosAdd)` shows who answers, with
  priority. `sys:calls` shows what is in flight. `usage()` shows handler counts beside everything
  else. P0 needed a separate `listened()` for the bus.
- **What is lost from `shared-commands`?** Standard-Schema input/output validation. P0 used
  `passthrough` everywhere, so there was no runtime loss here. Also lost: JSON Schema projection,
  which matters only if commands become AI tools or HTTP endpoints; it could come back as optional
  `input` / `output` fields on `defineCommand` without changing dispatch. Also lost: the
  `CommandsRegistry` views, the `async` / custom policies, `description` / `icon`, and "wait" for
  `silent` (P1 resolves `undefined`, so no caller hangs).
- **Policies and priorities over retained contributions?** Both are properties of the dispatch, not
  of the storage. The slot holds `{ handle, priority }`, and `call` sorts a snapshot. Arrival order
  breaks ties, because the plain slot keeps insertion order.

## Recommendation for consolidation

Adopt commands over slots: two kernel primitives, with the dispatcher (≈125 LOC) in the kernel and
`shared-commands` dropped. Keep the stricter semantics P1 pinned: first claim stops the dispatch;
skip handlers withdrawn mid-dispatch; handler errors unwrapped; `silent` resolves `undefined`;
`abandoned` on claimer withdrawal; in-flight calls in `sys:calls`. Amend the definition in two
places. (1) Coverage: command slots are read by dispatch, so exclude them from "unobserved", and
treat a declared command with no handler as a separate, optional report line. (2) The renderer
boundary rule must name the free functions. Treat schemas and JSON projection as an optional
add-on for when a command crosses a realm boundary. The next step toward R3's benefits is small:
record settled outcomes (not just pending ones) in a bounded slot, so forms can project their
failures. Stop there, without replay.
