# P4 — lessons

Prototype **P4** (`apps/mvc-blueprint-12`): P0 with **one shared reactive substrate** across
bundles. The kernel owns the graph (`kernel/reactive.ts`, alien-signals 3.2.1); `todos:collection`,
`todos:selection` and `contacts:selection` are published as `Readable<T>` (a tracked read plus the
model contract's channel `.subscribe`); consumers derive from them with `computed` or an action's
`when` guard. Status: **DONE** — every acceptance criterion met. The verdict is negative on the
headline idea and positive on a narrow opt-in variant (see Recommendation).

## History

| Commit | What |
| --- | --- |
| `d04e49d` | copy of P0 (`mvc-blueprint-04`) as the base |
| `f5280fa` | the substrate in the kernel, `Readable` facets, six consumers converted, glitch test (runs on P0 and P4), substrate-reach report |
| `b5f44ea` | interop tests (plain consumer, plain producer, glitch at the bridge, realm hop), contract suite on `Readable`s |
| `2a6fa88` | `track(get, on)` — the substrate as an opt-in behind P0's contract; README |

## The glitch test (acceptance 2)

`tests/glitch/glitch.test.ts` is black-box: it reads only published view models (what a renderer
reads), so the same file runs against P0's sources (`pnpm test:glitch-p0`, aliases pointed at
`../mvc-blueprint-04`, read-only) and against P4. In every notification of every observed model it
checks four cross-bundle invariants — I1 header "N open todos" = open rows; I2 contacts link enabled
= a contact selected; I3 Rename enabled = exactly one row selected; I4 Clear completed enabled = some
row done — plus an intra-model control (I0). Scenario: selections, toggle, add, delete of a selected
row, clear completed, four contact selections.

| Observers subscribed | P0 | P4 |
| --- | --- | --- |
| late (after activation — as a renderer mounts) | 0 violations / 41 checks | 0 / 41 |
| early (each model the moment it is published — a bundle activated before the deriving ones) | **11 violations / 42 checks** (I3 ×8, I2 ×3) | **0 / 42** |

So P0 **does** glitch, but only for an observer that subscribed to the owner before the bundle that
derives from it (the controller-set guard is written from a listener that runs after the early
observer's). Renderers mount late, so no rendered frame in P0's e2e ever showed it, and React batches
anyway. I1 and I4 never glitched even early: the header item and the Clear-completed action only exist
after their controllers subscribed.

## What worked

- **Cross-bundle derivation is real and small.** P0's three controller-set cross-bundle guards
  (lesson 4 there: link ← `contacts:selection`, Rename ← `todos:selection`, Clear completed ←
  counts) became `when:` guards in the action model — "effective `enabled` is derived in the model"
  now holds across bundles, same-tick and glitch-free.
- **No listener bridges left** for the converted state: P0 had 7 cross-bundle subscriptions in
  controllers (status, link, rename ×2, clear, list, edit), 5 of them writing a derived value, and 5
  mutable holders (`let collection`, `let selected`); P4 has 0 and 0 — seven `firstOf(slots, decl)`
  calls (a slot's first contribution as a tracked read) replace them. `todos.list`'s items are derived from the
  collection; its `publishItems` writer is gone.
- **The model contract still holds at the boundary.** `Readable.subscribe` *is* the contract's
  channel: the MODELS.md §4 suite passes on `todos:collection` (todos, counts), on `todos:selection`,
  and on a hand-rolled producer through the bridge — adapting a contract test was a one-line change
  (`read: m.view.todos, subscribe: m.view.todos.subscribe`).
- **Nothing outside the logic moved**: 0 renderer, host or `hello` files changed; the DOM renderers
  compile and pass; e2e 24/24 under React and DOM; standalone and removal runs unchanged.
- **A plain-listener consumer interoperates with no library**: it only calls `.subscribe` on the
  facet (`tests/interop`, "plain CONSUMER").
- **Opt-in without a second contract works** (`track(get, on)`, `tests/interop/optional.test.ts`):
  keep P0's `getX`/`onXUpdate`; an owner opts in by making `getX` a kernel `Readable`; a consumer's
  `track` uses it directly (early observer: **0** glitches) or bridges a plain owner (**4 of 4**
  transitions glitched for the early observer, correct afterwards).

## What failed or cost more than expected

1. **The gain is small against the benchmark.** Logic LOC 1758 → 1734 (**−24**, −1.4%); per bundle:
   `todos.contacts-link` 54→43, `todos.list` 283→274, `todos.rename` 134→129, `todos.clear-completed`
   146→144, `todos.edit` 153→152, `todos.core` 195→194, `todos.status` 26→29, `contacts.list`
   208→210. The kernel grew +95 (`reactive.ts`, 94 LOC incl. `track`) and the kit shrank −23 (the
   signals wrapper moved): **+46 non-test LOC overall**. The controllers' real cost (snapshots, update
   loops, running flags, `active` checks — P0's recommendation) is untouched by a substrate.
2. **Coupling becomes total and invisible.** Runtime reach to alien-signals (value-import closure):
   **P0 10/20 bundles** (those using the kit) → **P4 20/20** — `hello`, the renderers and the hosts
   now load the library through the `@kernel` barrel. Contract reach: 0 → **8 bundles** whose
   published or consumed contract is expressed in `Readable`. API modules gained **no library
   import** (only `import type { Readable } from "@kernel"`, 2 modules) — the coupling is in the
   *semantics* (a tracked read means "tracked on this graph"), which no import rule sees. A second
   copy or version of the library would silently turn every cross-bundle derivation into a stale read.
3. **A producer cannot opt out.** A `Readable` is branded; a bundle on plain listeners (or a remote
   proxy) can only publish shared state through the kernel's `fromChannel` — and the glitch comes back
   at that bridge (`tests/interop`: an early listener saw "3 open rows" with "2 open todos").
4. **Realms**: a `Readable` cannot cross `postMessage`. A worker-side owner needs a proxy that
   bridges a message stream (`fromChannel` again); derivations lag by one hop (pinned: the worker's
   command resolved, the main side still said "2 open todos") and identity (contract point 7) is lost
   at every clone. P4's guarantee is strictly in-realm — the same place P0 already had "same tick".
5. **Tracked vs untracked reads become a rule authors must hold**: reading shared state inside a
   `computed`/`effect` subscribes, elsewhere it does not. Commit-time reads were safe only because
   the kit's submit listeners run untracked; a read in the wrong place makes an accidental dependency
   (not hit here, but it is the classic signals bug and nothing in the boundary suite catches it).
6. Small: `Signal<T>`'s overloads had to be reordered (read last) for a signal to infer as `() => T`
   when passed to `readable`; `todos.status`'s header text needed a *stable* group, not a plain
   `computed` (a new object per counts change would notify on equal text — contract point 3).

## Pros

- Glitch-free cross-bundle derived state, measured: 11 → 0 intermediate states for early observers.
- Guards and derived presentation from other bundles live in the model, as the definition wanted;
  controllers lose their bridging listeners and holders.
- The contract suite and the U1 bindings still apply: a `Readable` is `(read, subscribe)`.
- Renderers are unaffected; the second UI technology needed nothing.

## Cons

- Every bundle is bound to one library *and one instance/version* of it through the kernel; the
  binding is semantic, so the boundary suite cannot police it (R7 now only says "one file imports
  alien-signals").
- ADR-008's "bundles with different substrates interoperate" survives only for consumers; producers
  must bridge, and bridged state loses the one thing P4 adds.
- +2 concepts (28), +95 kernel LOC; `hello` now carries the reactive library at runtime.
- No help across realms, which is where independence matters most (workers, remote apps).

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **28** | P0's 26, rule 21 changed, + `Readable`/tracked read, + the bridge (README) |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | **80 LOC / 2 files** (unchanged) | but its runtime closure now includes alien-signals (via `@kernel`) |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | **n/a** — not re-run | P4 changes no feature flow; `todos.rename` is 129 LOC vs P0's 134 (its selection listener became a `when` guard) |
| Separation | boundary suite: rules / violations | **8 rules / 0 violations** | R7 redefined: alien-signals only in `kernel/reactive.ts`; + substrate-reach report (P0 vs P4) |
| Separation | single-writer violations | **0** | type-level suite unchanged and green; a `Readable` exposes no writer |
| Separation | domain-logic hits in views | **2** (unchanged) | renderers untouched (P0's Ctrl-click arithmetic) |
| Independence | cross-bundle edges / to API modules / violations | **56 import sites (37 distinct) / 56 / 0** | identical to P0's tree (edge lists diffed); **substrate reach: 20/20 bundles** reach alien-signals (P0: 10/20); **8** bundles' contracts expressed in `Readable` (P0: 0); API modules naming a substrate type 2 (P0: 0), importing a library 0 new |
| Independence | standalone runs (Todos, Contacts) | **pass / pass** | coverage reports as P0 |
| Independence | removal runs: errors / coverage report | **4 runs, 0 error logs** | coverage reports identical to P0 (tests unchanged) |
| Composability | interactions (1)–(3) pass | **3/3** | headless, React, DOM |
| Composability | files changed in Contacts for interaction (1) | **0** | P4 itself changed 2 Contacts files (`contacts/api`, `contacts.list`) to put `contacts:selection` on the substrate — a platform change, not the interaction's |
| Composability | second UI technology: logic files changed / new UI LOC | **0 / 0** | DOM renderers unchanged, compile, e2e green; U1's bindings take `(r, r.subscribe)` unchanged |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | **green** | contract 99 (incl. 4 runs on `Readable`s, one hand-rolled via the bridge) + controls 7 + single writer 4; commits 9; dispose 4; late 3; read-then-set 7 + loader 7; **glitch 2 (P4 0/0; P0 0/11)**; interop 6 |

Totals: node **175** tests (16 files), Chromium **24**. LOC (non-test): kernel 439 (P0 344), kits 550
(573), API 286 (288), logic 1734 (1758), UI 1232 (1232), app 191; tests 3018.

## Answers to the points to clarify

- **Did P0 show a glitch or a cost that P4 removes?** Yes to both, both small. Glitch: 11
  intermediate states in the scenario, **only** for observers subscribed before the deriving bundle
  (0 for late observers such as renderers; never visible in P0's UI tests). Cost: 3 controller-set
  guards, 7 bridging subscriptions (5 writing a derived value) and 5 holder variables — about 24 logic LOC. P4 removes both, and
  adds 95 kernel LOC and total coupling.
- **Could the shared substrate be optional without two contracts?** Yes, if the contract stays P0's
  (`getX`/`onXUpdate`) and the substrate is a negotiated fast path: an owner opts in by making `getX`
  a kernel `Readable`; consumers follow any group with `track(get, on)` — direct (glitch-free) for an
  opted-in owner, bridged for a plain one. Measured: 0 vs 4/4 glitches for an early observer. The
  headline P4 shape (`Readable` in the API types) is *not* optional: producers must be on the graph
  or bridge through the kernel.
- **What happens to a bundle in another realm?** Its `Readable`s cannot cross. A proxy bundle
  bridges a message stream into a local `Readable` (`fromChannel`); derivations stay correct but lag
  by one hop, glitch-freedom stops at the proxy, and snapshot identity must be restored by the proxy
  (the consumers' stable groups hid it here). Exactly the P0 situation — P4 adds nothing across realms.
- **Dependency graph (acceptance 3):** every bundle now reaches the library (20/20, via `@kernel`);
  no API module gained a library import — two gained a type import of `Readable` from the kernel.
- **UI replacement impact (acceptance 4):** none for the current renderers (they read unchanged
  view facets). U1's bindings (`useModel(get, on)`, Svelte `modelStore(read, subscribe)`, Solid) take
  a `Readable` as `(r, r.subscribe)`. The substrate does not make Solid/Svelte bind natively — they
  have their own graphs, so they still bridge through `.subscribe`; native binding would require the
  logic's substrate *to be* the UI library's (Solid signals), which breaks R3.
- **Contract tests adapted (acceptance 1):** `contract.test.ts` — the two `todos:collection` runs
  (`getTodos/onTodosUpdate` → `todos/todos.subscribe`, `getCounts/onCountsUpdate` →
  `counts/counts.subscribe`) and the list-selection run (`publishItems` → a fixed items source);
  `boundaries.test.ts` — R7's allowed file. Everything else in P0's suites is unchanged.

## Recommendation for consolidation

Keep ADR-008: the contract (`getX`/`onXUpdate`) stays substrate-free at bundle boundaries. Do **not**
put a reactive type into API modules — the benchmark's gain (−24 logic LOC, a glitch only early
observers see) does not pay for binding every bundle to one library instance, and it buys nothing
across realms. Adopt two small things instead:

1. **The opt-in fast path** as a *kit* feature (not kernel): the model kit marks the getters it makes
   (its models already share one alien-signals instance in process), and a kit `track(get, on)` lets
   a model's `when` guard or derived group follow another bundle's group — direct when the getter is
   kit-made, bridged otherwise. That gives P0's lesson 4 ("cross-bundle guards derived in the model")
   without changing any API module, and degrades to P0 behaviour for plain or remote producers.
2. **`firstOf(slots, decl)`** (a slot's first contribution as a tracked read) next to `followFirst`
   in the slots kit — it is what removed the holder variables.

State in the definition that "same-tick" is guaranteed in process but **glitch-freedom is not**
unless both sides use the kit, and that renderers are unaffected either way (they subscribe late).
