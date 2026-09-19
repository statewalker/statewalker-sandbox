# P5 — lessons

Prototype **P5** (`apps/mvc-blueprint-13`): the consolidated architecture **K** (CONSOLIDATION §4)
on the full benchmark, React and Solid, the 17 owner decisions built as their recommended option.
Status: **DONE**. K equals or beats P0 on every axis but two measured misses: kernel + bus LOC
(730 against a ≤ 700 target) and the neutral shell-host bar (Solid host 180 LOC against < 150).
The readability self-review found one bug in P5's own `contacts.edit`; it is fixed and pinned.

Tests: `pnpm test` **212** (node), `pnpm test:browser` **31** (Chromium), `pnpm typecheck`,
`pnpm build` — all green, stable over 3 consecutive runs.

## History (the commits are part of the evidence)

| Commit | What | Logic-bundle files touched |
| --- | --- | --- |
| `f9f0ba3` | copy of P1 (`mvc-blueprint-09`) as the base; 162 node + 24 browser green | (copied) |
| `fbf9ccb` | D13: every kernel/kit/bundle folder a package with `exports`, linked with `link:`; no aliases; plain DOM dropped | moved, 0 edited |
| `ad9c841` | **K in the logic**: kernel `Scope`, loader bundle scopes, `@p5/kit-commit` (C + scoped drain), `@p5/kit-form`, `@p5/kit-track`; every controller converted; `@kit/loop`, `createAction`, `ActionControl` deleted; `toggleSelected` | all |
| `727a810` | kernel scope tests, P3's 15 races (12 here, 3 with Rename), D4 outcome tests, P2's dispose-mid-commit tests, boundary rules R9–R12 | 1 (module state) |
| `f27763d` | **Solid** over the neutral shell-host model (`@p5/kit-shell`); e2e × 2 technologies; binding probe | **0** |
| `1997cc4` | P4's glitch test: 0 / 0 | 0 |
| `ee92f5c` | **Rename a todo** (§14.6) in one commit | new bundle + 2 API lines |
| `b4c0a4b` | readability self-review's bug: a validation failure after the session closed was lost | 1 |

## What worked

1. **Zero commit plumbing and zero liveness checks in every controller**, not only the four P3
   varied: 0 `running` writes, 0 `??=` folds, 0 `onSubmits`, 0 update loops, 0 `session !== s`,
   0 `active` checks across all 11 logic bundles (P0: 10 / 5 / 10 / 4 / 3 / 6). `grep` over
   `packages/bundles` finds none; the boundary rule R11 keeps it that way.
2. **C composes with scopes with no check left** (point to clarify 1). The drain is created in the
   session scope, subscribes there, and — for records already accepted — continues in the bundle
   scope after the session closes. A record captured in s1 and drained after s1 closed is committed
   and reported (test). Writes to the closed session's models are no-ops (they are disposed with
   it); the bundle's notification is the outcome. That *is* "the narrowest open scope takes the
   outcome", made structural.
3. **D4 is pinned by tests**: cancel-mid-save × success/failure, replace-mid-save × success/failure,
   replace during the validation step (failing), a record drained after its session closed, and
   `todos.edit`'s replace-failure — 7 tests. A mutant that drops the drain with the session (P2's
   silent drop) fails 4 of them. P0's asymmetry cannot be written any more: success and failure
   both notify through the same path.
4. **Disposal by scope needed no write interception** (D3). P0's 4 dispose tests, P2's 2
   dispose-mid-commit tests and P3's 2 dispose races pass on scopes alone: `scope.task` drops the
   continuation, the loader closes bundle scopes in reverse, a claimed call whose owner leaves is
   rejected `abandoned`.
5. **One mechanism for every commit.** Save, Cancel, Add (queued), Toggle/Edit/Delete, Clear
   completed, Rename…, Rename, "New todo…", Edit contact, "New todo for this contact" — all records.
   P3's "two entry points" for Clear completed is gone: the `todos:clear-completed:ask` command
   *submits the action*, so the action is `running` exactly while its dialog is open whichever way it
   was asked.
6. **Logic shrank.** Logic bundles 1758 → **1256** LOC (−29 %; P0 counted with its Rename). Logic +
   non-UI kits 2217 → 1946 (−12 %). `contacts.edit` 209 → 110, `todos.edit` 243 → 115,
   `todos.clear-completed` 171 → 112, `todos.contacts-link` 54 → 34, `todos.rename` 194 → **86**.
7. **Rename is +101 logic lines** (P0 +216, P3-C −31 on the bundle): a kit form, a kit guard, a
   dialog session, one drain — no hand-written form model (the ledger's "share model factories
   through a kit" did the work).
8. **Solid touched 0 logic files** (commit `f27763d`), all e2e scenarios pass under both
   technologies, and U1's host rules hold: setup-once components re-create a renderer exactly when a
   contribution changes identity (the shell-host model keeps an entry's identity until its
   contribution or renderer changes), inputs are controlled, focus returns to the last focused
   element.
9. **Glitch-free kit-to-kit, measured** (D11): P4's black-box glitch test gives 0 violations for
   late and early observers (P0: 11 early). With the kit's direct read disabled (every getter
   bridged) the early observer sees 3 I2 glitches again — the guarantee is exactly "kit-to-kit".
10. **Package exports cost no tooling** (D13). `link:` dependencies make `@p5/*` resolve through
    `node_modules` in Vite, Vitest and `tsc`: the alias table and `paths` are gone. A 90-line
    script writes each `package.json` from its imports; R12 fails on an undeclared import or a
    cycle. The graph is now a real package graph: 35 packages, 124 declared `@p5` edges, acyclic.
11. **"No module-level mutable state" found four real cases** once applied to the kernel and kits
    too: P1's call-id counter (moved into `KernelSlots`), P3's global commit `seq` (cross-action
    order is now the drain's arrival stamp), the notifier's id counter, and U1's/P0's host
    `lastFocused` (now per mount, `@p5/kit-host`'s `newFocusReturn`).

## What failed, or did not deliver

1. **Kernel + bus LOC is 730**, not ≤ 700: P1's 436 + `scope.ts` 84 + a call-id method = 521, plus
   `shared-slots` 209. The brief's budget assumed a smaller scope; nothing in it is removable
   without dropping a guarantee (reverse close, children first, dropped continuations, abort,
   early release, first-failure report).
2. **The neutral shell-host model misses its bar** (D15). Solid host **180** LOC (U1: 286, −37 %),
   plus a 152-LOC technology-neutral kit shared by any host. The rule was "keep it only if the host
   drops below 150": by that rule it is not kept as the default. It pays for itself only from the
   second technology that adopts it (React's host is still 267).
3. **The existential cast moved, not vanished.** `reactRenderer(kind, C)` / `solidRenderer(kind, C)`
   hold the renderer-slot cast once per technology, and the Solid host still passes the model
   `as never` into `<Dynamic>`. A heterogeneous keyed slot cannot be typed without one.
4. **The outcome rule is structural for the drain, not for handlers.** The drain guarantees a
   handler runs and its notification lands; it cannot guarantee a handler *notifies* on every
   failure path. P5's own `contacts.edit` reported a validation failure only to the form, so after
   a replace during validation it was lost — the readability self-review found it (fixed in
   `b4c0a4b`, test added). A kit `fail()` helper or a lint would make it structural.
5. **"Await only through `task`" is still a rule** — it replaced "check active after await". The
   difference is that R11 checks it mechanically (every `await` in a controller must be
   `await task(…)`/`await x.task(…)`); a helper that awaits internally (`run` in `todos.list`) had
   to be restructured so the rule could see it.
6. **Records are not strictly view-written any more.** The clear-completed command submits the
   action on the controller's behalf. It is the same intent from another source, but the
   single-writer statement "records: the view, through `submit`" becomes "records: the intent
   source, through `submit`".
7. **K-M was not tried** (time box). Whether C composes with a chart stays open.
8. **React cannot survive a model that breaks contract point 7**: U1's binding probe with unstable
   snapshots sends `useSyncExternalStore` into "Maximum update depth exceeded". Solid wastes 40 field
   reads per 10 no-ops but renders nothing wrong. The contract suite, not the binding, protects a
   React renderer; the probe runs "stable" only for React.

## Pros

- The controller is four parts in one file, and each part's mistakes are either unwritable
  (`running`, settling, folding) or caught by a boundary rule (bare `await`, module state, service
  reach, undeclared package import).
- One disposal mechanism (scopes) and one commit mechanism (records) for every bundle.
- The outcome of every commit is defined in all three scope states and tested.
- The logic is importable by a second app as packages with `exports`; the package graph is checked.
- Two UI technologies, zero logic edits, one scenario file.

## Cons

- Four kits carry K's conveniences (`commit` 192, `form` 118, `track` 42, `shell` 152); a newcomer
  reads `@p5/kit-commit`'s drain semantics before the first controller makes sense.
- Scopes add a parameter and three verbs (`defer`, `child`, `task`); "which scope does `task`
  belong to?" (the bundle's, via the drain) is not visible at the call site.
- 35 `package.json` files (generated) and a lockfile entry per package; Rename touched 2 of them.
- The kernel grew (344 → 521) while the bus library shrank (790 → 209).

## Fitness table — P5 beside P0

Measured as ARCHITECTURE §13 prescribes; unweighted. P0 values from `apps/mvc-blueprint-04`.

| Axis | Measurement | P0 | **P5** | Target | Notes |
| --- | --- | --- | --- | --- | --- |
| Simplicity | concepts and rules | 26 | **26** | ≤ 26 | 7 rewritten (6, 9, 11, 19, 24, 25, 26); Scope added, "check active after await" removed (27 if Scope is counted as new and the removed rule as part of 11) |
| Simplicity | `hello` LOC / files (no kit) | 80 / 2 | **79 / 2** (+ `package.json`) | ≤ 80 / 2 | activator 72 + API 7 |
| Simplicity | Rename: files, lines | 11 files, +291/−11 (logic +216) | **11 TS files + 2 `package.json` + lockfile, +251/−10; logic +101** (bundle 86 LOC) | ≤ 11 files; logic ≤ +185 | UI 2 files +4/−2; tests 6 files +124/−8 (incl. the 3 Rename races) |
| Simplicity | commit plumbing: `running` writes / folds / `onSubmits` / loops / `session !== s` / `active` | 10 / 5 / 10 / 4 / 3 / 6 | **0 / 0 / 0 / 0 / 0 / 0** | all 0 | over all 11 logic bundles |
| Simplicity | kernel + bus-library LOC | 1134 | **730** (521 + `shared-slots` 209) | ≤ 700 | **miss by 30** |
| Simplicity | readability of `contacts.edit` | ~20 min, 1 bug | **~15–20 min, 1 bug found and fixed** (self-review, not independent) | ≤ 20 min, 0 bugs | see below |
| Simplicity | logic LOC (all logic bundles) | 1758 | **1256** | — | logic + non-UI kits 2217 → 1946 |
| Separation | boundary rules / violations | 8 / 0 | **12 / 0** | ≥ 10 / 0 | + R9 owner-only `:api`, R10 no module state (kernel incl.), R11 await through `task`, R12 declared acyclic packages; each with a negative control |
| Separation | single-writer violations | 0 | **0**; `running` write is a type error | 0 | `@ts-expect-error` in `single-writer.test.ts` |
| Separation | domain-logic hits in views | 2 | **0** | 0 | `toggleSelected(id)`; Ctrl-click e2e × 2 technologies |
| Independence | cross-bundle edges / to API / violations | 53 (35) / 53 / 0 | **52 (36) / 52 / 0**; package graph 35 packages, 124 edges, acyclic | 0 violations | P0's set had DOM renderers, P5's has Solid |
| Independence | standalone / removal | pass / 4 runs, 0 errors | **pass (headless, React, Solid) / 4 headless runs + 2 per technology, 0 errors** | per technology | |
| Composability | interactions (1)–(3); Contacts files for (1) | 3/3; 0 | **3/3 × 2 technologies; 0** | | |
| Composability | second technology: logic files / UI LOC | 0 / 791 (DOM) | **0 / 453 (Solid)** + 152 shared shell-host model | 0 / ≤ 570; host ≤ 286, or ≤ 150 with the neutral model | Solid host **180**: meets ≤ 286, **misses ≤ 150** |
| Correctness | suites | green | **green**: contract 91 + controls 7 + single writer 4; commits 8 + **15 races** + rename 1 + **7 D4 outcome**; dispose 4 + **P2's 2**; **glitch 0/0**; late 3; loader 7, read-then-set 7, **dispatcher 12**, **scope 11**; standalone, removal; Chromium 31 incl. **binding probe** × 2 | all green | |

## Decisions D1–D17: what building the recommended option taught

- **D1 C.** Adopt. All 11 bundles commit through records where they commit at all, not only forms: menu actions and cross-app
  actions too. The mechanism needed one change: cross-action order is the drain's arrival stamp
  (P3's global `seq` counter broke R10). Cost if wrong is as stated (kit + control facet).
- **D2 K, machines opt-in.** Adopt K. With C + scopes a controller has no lifecycle bookkeeping
  left for a chart to take over; K-M was not built, so "does C compose with a chart" is unanswered.
- **D3 kernel scopes, no write interception.** Adopt. Every dispose test passes without
  interception; the one leak class scopes alone do not close — a continuation that awaits
  something *not* through `task` and then calls a command — is closed by R11, statically.
- **D4 narrowest open scope.** Adopt, with the drain rule "a session's accepted records are
  handled in the bundle scope after the session closes". 7 tests. Lesson: the drain makes the
  outcome *reachable*; handlers must still report every failure path to a notification (one bug
  found). A kit `fail()` would make it structural.
- **D5 commands over slots.** Adopt. Kept P1's dispatcher; its 12 tests pass; `abandoned` falls out
  of scopes for free (a handler contributed in a scope is withdrawn when it closes).
- **D6 `silent` → `undefined`.** Adopt; no benchmark code waits.
- **D7 `abandoned` rejects.** Adopt. `describeError` reads it as "not completed". In the benchmark
  it never reaches a user: the loader closes callers before owners (reverse activation), so only
  a unit test reaches it. It matters only for partial teardown, which the loader does not offer.
- **D8 refuse / queue per action.** Adopt. Only Add is queued; "dispose with Adds queued" sends the
  one in flight and drops the rest (nothing may be written after deactivation).
- **D9 domain owner.** Adopt, unchanged from P0.
- **D10 boundary rule over scopes.** Adopt. R9 is generic (any adapter an API declares with an
  `<app>:api` key belongs to `<app>.core`); host services (`shell:*`) had to be excluded.
- **D11 private substrate + kit `track`.** Adopt. 0/0 glitches; a producer opts in by marking a
  getter `readable` (4 getters). Used for 3 guards (link, clear completed, Rename…).
- **D12 fsm upstream.** Not exercised.
- **D13 package exports.** Adopt. No tooling cost with `link:`; a generator keeps `package.json`
  honest; R12 checks it. Cost: +1 non-TS file per bundle (Rename +2).
- **D14 guard wrapper.** Keep the wrapper for now; its API (`isProvided`, read-then-set) was used
  unchanged by both `*.core` bundles — ready to upstream.
- **D15 neutral host model.** By its own rule: **do not adopt as default** (180 > 150). Keep it as an
  optional kit: −106 LOC per technology after the first, one more model to learn.
- **D16 `toggleSelected`.** Adopt: domain hits 2 → 0 in two technologies, one line of model.
- **D17 manifest dependencies.** Adopt, unchanged from P0/P1.

## Answers to the points to clarify

- **Does C's drain compose with scopes without a check left — a record captured in s1, drained
  after s1 closed?** Yes. The drain continues in the bundle scope; the record is committed and its
  outcome notified (test "a record captured in s1 and drained after s1 closed …"). 0 checks.
- **What does a queued record do when its scope closes?** A session's records are handled in the
  bundle scope. When the *bundle* closes, the drain is dropped: records not started are neither
  sent nor settled (their models are disposed with the bundle). Dropped, not "abandoned".
- **Is `abandoned` surfaced to the user anywhere (D7)?** Only as "not completed" in a failure
  notification, and only if the caller's scope outlives the owner's — which the loader's reverse
  order prevents in the benchmark.
- **Does the neutral shell-host model survive Solid's reactivity rules, and does it remove the
  existential cast?** It survives: every group is a model under the contract, `<For>` by reference
  works because the model keeps entry identity. The cast is moved (one `as never` in the host, one
  helper per technology), not removed.
- **Does packaging change the graph numbers or the `hello` LOC?** No: 52 cross-bundle import sites,
  0 violations; `hello` 79 LOC / 2 TS files. It adds one `package.json` per package.
- **K-M: does the chart consume records, or does the drain dispatch events into it?** Not tried.

## Readability self-review of `contacts.edit` (P2-readability protocol, NOT independent)

The contract forbids sub-agents, so this is the implementer's own read, done cold on the final
files; treat the time as optimistic.

- **Files:** `packages/bundles/contacts.edit/index.ts`, `packages/kits/commit/index.ts`
  (`drainCommits`, `on`, `Turn`), `packages/kernel/scope.ts`, `packages/kits/form/index.ts`.
- **(a) How it works.** Open: close the previous session scope, open a child scope, create the form,
  drain Save/Cancel in it, publish the panel in it. Save: the handler gets the draft captured at
  submit; step 1 validates, step 2 calls `contacts:update`, both awaited through `task`; failure →
  form errors + notification; success → notification + close. Double Save: refused by the action
  (running is derived). Cancel mid-save: drained after the Save, so the Save's outcome is reported
  first. Replace mid-save: the old session closes, its Save continues in the bundle scope and
  notifies; its form writes are no-ops. Dispose mid-save: the bundle scope closes; the continuation
  is dropped; nothing is written.
- **(b) Had to read twice.** Which scope `task` belongs to (the bundle's, not the session's) — it is
  in the kit's comment, not at the call site. That `drainCommits(editor, …)` outlives `editor` for
  records already accepted.
- **(c) Effort.** Low–medium: 4 files, ~15–20 minutes, most of it in `drainCommits`.
- **(d) Bug found.** A validation (step-1) failure was reported only to the form, so a replace during
  validation lost it. Fixed in `b4c0a4b` (every failure → form + notification) and pinned by a test.

## Recommendation for consolidation

Adopt **K as built here** as the definition, with these amendments to CONSOLIDATION §4:

1. §4.5: state the drain rule precisely — "records accepted in a session are handled even if the
   session closes; the drain continues in the bundle scope; writes to the session's disposed
   models are ignored; when the bundle closes, the drain and its continuations are dropped" — and
   add "every failure path of a handler notifies" (or a kit `fail()`), since the drain cannot
   enforce it.
2. §4.4: replace "no check after `await`" by "await only through `task`", checked by a boundary
   rule (R11); add R9–R12 to the boundary suite.
3. §4.1: extend "no module-level mutable state" to the kernel and kits (4 real cases found);
   cross-action commit order is the drain's arrival order.
4. D13: package exports via `link:` dependencies and a generated `package.json` per package.
5. D15: keep the neutral shell-host model optional; it misses the 150-LOC bar for one technology.
6. Raise the kernel budget to ~730 with scopes, or accept that scopes cost ~85 LOC.
7. Open: run the readability review independently; try K-M on C + scopes before recommending the
   machine kit.

## P5.1 iteration

The iteration after the [independent analysis](../../../../../docs/sandbox-apps/architecture/prototypes/P5-analysis.md)
(umbrella `docs/sandbox-apps/architecture/prototypes/P5-analysis.md`), items 1–9 of "What to
iterate before the guideline is written", in priority order, on branch `spike/p5-iteration`, in
place. Each weak point's probe became a test first (red), then the fix (green).
Status: **DONE** — all nine items addressed; three sub-points deliberately not done (below, with
reasons). Tests: `pnpm test` **228** (212 + 16), `pnpm test:browser` **33** (31 + 2),
`pnpm typecheck` (incl. the T1 `@ts-expect-error` lines), `pnpm build`, `node scripts/packages.mjs
--check`; `pnpm install --frozen-lockfile` unchanged (no lockfile edit, no new dependency).

| Commit | Items |
| --- | --- |
| `c74cc3f` | 1 — W1 fault containment |
| `7b9823b` | 2–7 — W2 lanes, W4 claim, W5/W12 `submit(): boolean`, W6 `answer`/`observe`, W3/W7 turn and scope, W9 patch; parts of 9 (W11, W17, W18) |
| `502ff77` | 8 — W8 peers + singleton |
| `f8b7554` | 9 — `without` to test support, the last unnotified failure path, N1 |

### What each item became

| # | Item | Built as | Gate (probe inverted) |
| --- | --- | --- | --- |
| 1 | Fault containment (W1) | React: a `Contained` class boundary around every panel, dialog, header item, menu item and toast; Solid: `<ErrorBoundary>` around the same. A failure renders "⚠ <title> failed" in place, is logged (`shell:render-failed`) and listed in `shell:coverage` as `failed` (dropped when the contribution is withdrawn; a new contribution under the same id renders afresh). Dev guard: React `useModel` reads the getter twice on first render and throws `"getState returns a new value on every call (model contract point 7)"` — gated by `import.meta.env.DEV` (the production build never runs it). | `tests/e2e/containment.test.tsx` × React/Solid: a throwing renderer (I1), a point-7 model (R1, React), a throwing header model — Todos, Contacts and the menu still render; `failed` lists exactly the bad ids |
| 2 | Cancel preempts, lanes (W2) | **Lanes, not a new option**: each `drainCommits` call is one lane; Cancel/close are drained in their own lane in every editor and dialog (`contacts.edit`, `todos.edit`, `todos.rename`, `todos.clear-completed`); `todos.list` has an Add lane and a selection lane. The turn gets `signal` (the record's session). D4 still reports the running Save. | A1 inverted (hung `update`: the panel closes within 100 ms; "Saved Ada K." when released); B1 < 150 ms (merging the lanes back measures **402 ms**); the 2 cancel-mid-save D4 tests re-pinned: closes at once, toast later |
| 3 | Claim + `submit(): boolean` (W4, W5, W12) | `CommitControl.claim()`, called by `drainCommits` — a second drain throws "already drained". `ActionView.submit(): boolean`; a throwing or non-cloneable `capture` refuses (`false`) and logs. `todos:clear-completed:ask` rejects "busy" / "nothing to clear". | C1, C2, C4, C5 inverted (`drain.test.ts`); ask refusal (`commits.test.ts`) |
| 4 | `answer` vs `observe` (W6) | `answer` always claims (sync or async); `observe(fn: … => undefined)` sees every call first and never claims; no priorities, no `true`-claims, no `sys:calls`, no call ids; `defineCommand(…, { policy: "silent" })` returns `CommandDeclaration<P, R \| undefined>`. Controllers' `answer`s are now plain functions — no `async` written to mean "claim". | K1/K2 inverted; T1 lines are `@ts-expect-error` (async observer, `priority`, silent result as `string`) — they fail to compile |
| 5 | Scope-aware verbs, R11 (W3, W7) | `turn.call(decl, payload)` = `scope.task(() => call(…).promise)`: never dispatched once the bundle closed; `Scope.task(fn)` does not start `fn` on a closed scope; `each(scope, stream, fn)` for streaming controllers; R11 now covers every logic file that value-imports `@p5/*` (pure backends with type-only imports are exempt by reachability) and flags `.then(` on anything but a `task(…)`. | S1 inverted (bare await, then `turn.call` after close: nothing dispatched, never settles); S3 inverted; E2's `.then` / `for await` caught (negative controls); R11 found `validate.ts`'s bare awaits (rewritten) |
| 6 | Explicit drain ownership (W7, W14) | `drainCommits({ scope, session?, slots, log }, …)`: the bundle scope is named at the call site; `Scope.parent`, `Scope.isBundle` and `newScope`'s parameters are gone. | the session-outlives test passes with the owner explicit; kernel scope tests unchanged otherwise |
| 7 | `contacts.edit` lost update (W9) | `changes(base, draft)` in `@p5/kit-form`; `contacts:update` gets only the changed fields. | A7 (`outcome.test.ts`): the replacing editor's phone Save leaves "Ada K." in place and sends `{ phone }` only |
| 8 | Peers + singleton (W8) | The generator writes `@p5/kernel` and `@p5/kit-*` as `peerDependencies` (85 of the 124 `@p5` edges); R13 fails on a hard kernel/kit dependency; `getSlots` claims the context for its kernel copy (`sys:kernel`, a per-copy `Symbol`) and a second copy throws. | `tests/kernel/singleton.test.ts` (a `vi.resetModules()` second copy is refused on a shared context, works alone); R13 + negative control |
| 9 | Housekeeping | W11: the notifier drops an entry on timeout/dismiss (`size` 100 → 0). W17: `notifier.fail()` (notify + log) on every failure path that was only logged (`todos.contacts-link`, "New todo…", `contacts.list`'s editor open). W18: `session(scope, build)` replaces the two hand-written dialog promises. W10: the two `followFirst` value holders became one-shot `getSnapshot(decl)[0]` reads. `without` moved to `tests/support/without.ts`. | N1 (`drain.test.ts`); kernel **470** LOC |

### Not done, and why

- **"One CI job without hoisting" (item 8).** Nothing to un-hoist: the sub-packages are `link:`
  targets of the app, not workspace packages, so pnpm installs no `node_modules` for them —
  resolution always walks up to the app's. Making each a workspace package needs
  `pnpm-workspace.yaml` (a root file the contract forbids). The enforceable parts are done: peers,
  R12/R13, the runtime singleton check. Relative imports across packages remain R5's job.
- **A signal through `call` to API methods (W15).** The turn carries the record's `signal`; the
  kernel's `call` does not. Cancelling a cross-bundle write needs every API method to take a
  signal and every owner to honour it — kernel surface with no benchmark user. `contacts.edit`
  deliberately does NOT hand the record's signal to its Save: under D4, Cancel closes the editor
  and the Save still lands and is reported. The guideline should say which of the two a Save wants.
- **One follow-first verb (W10), fully.** The holder uses are gone; `followFirst` stays for
  "forward the owner's updates into my model" (`contacts.list`, `todos.list`, `todos.status`),
  `trackFirst` for guards. Unifying needs an effect verb in `kit-track` or list models that take a
  tracked source — a refactor of three list models for no behaviour change. Two verbs, two jobs
  (push vs pull), each named in the guideline.
- **`on(cancel, …, { preempt: true })`.** Not added: a second drain *is* the preemption, and it
  adds no concept. W13 (form + toast while open) is an owner choice and unchanged; W16/W19 were
  not on the list.

### Findings

1. **Lanes fixed both W2 scenarios with no new mechanism.** `drainCommits` was already one queue
   per call; what was missing was the rule ("one drain per independent stream; a session-closing
   intent never shares a lane with a long commit") and the claim that makes a second drain over the
   same action loud.
2. **Three existing tests had pinned the lost-update bug as correct**: they expected the whole
   draft (`{ name, email, phone }`) in `contacts:update`. Payload-shape expectations in race tests
   encode the patch policy; after the fix they pin `{ email }` / `{ name }` — stronger than before.
3. **Containment is not free in the hosts**: React host 267 → 334 LOC, Solid host 180 → 229
   (+67 / +49, boundaries around five contribution kinds plus the report path). D15's 150-LOC bar
   moves further away; the neutral host model does not carry the boundary (it is technology code).
4. **The kernel budget was met by deleting, not by squeezing**: `without` (test-only), priorities,
   `true`-claims, `sys:calls` + call ids, `parent`/`isBundle` paid for `observe`, the typed silent
   overload, the closed-scope `task` check and the singleton check. Kernel 521 → **470**; with
   `shared-slots` **679 ≤ 700**. Cost: "`running` for a command is derivable from `sys:calls`" is
   gone — no bundle used it; the dispose test now reads the backend's call log instead.
5. **R11 by reachability is the right scope.** Extended from `index.ts` to every file that can
   reach a scope, slot or command, it found one real helper (`validate.ts`, bare awaits — harmless
   today, a leak the day it calls a command). The mem backends are exempt by construction, not by
   a filename list.
6. **`answer` accepting a sync function removed the most confusing line** of the reference
   controllers: `async ({ payload }) => …` written only so that the handler claims. `observe` is
   typed `=> undefined`, so an async observer does not compile.
7. **`kit-commit` grew 192 → 234 LOC** (claim, boolean submit + capture guard, turn `call`/
   `signal`, `session`, `each`) while logic shrank 1256 → **1219**: the helpers moved lines out of
   five controllers.

### Fitness table — P0, P5, P5.1

| Axis | Measurement | P0 | P5 | **P5.1** |
| --- | --- | --- | --- | --- |
| Simplicity | concepts (ledger list) | 26 | 26 | **26** (6 rewritten again: `answer` / `observe`) |
| Simplicity | kit concepts a controller author needs (W10) | — | 9 (analysis) | **10**: commit action (`submit` → boolean), drain (owner + lane), `on`, turn (`task`/`call`/`signal`), `attempt`, notifier + `fail`, `trackFirst`, `followFirst` (forwarding only), form + `changes`, `session`; `each` for streams only |
| Simplicity | `hello` LOC / files | 80 / 2 | 79 / 2 | **79 / 2** |
| Simplicity | commit plumbing (6 counts) | 10/5/10/4/3/6 | 0/0/0/0/0/0 | **0/0/0/0/0/0** |
| Simplicity | kernel + bus LOC | 1134 | 730 (521 + 209) | **679** (470 + 209) — target ≤ 700 **met** |
| Simplicity | logic LOC / kits LOC | 1758 / — | 1256 / 925 | **1219 / 1010** |
| Simplicity | readability of `contacts.edit` | ~20 min, 1 bug | self ~15–20 min; independent ~35 min, ~10 files, +1 data-loss bug | not re-measured; the data-loss bug fixed and pinned (A7); the drain owner and Cancel's lane are visible at the call site (the analysis' confusions 1–4 addressed) |
| Separation | boundary rules / violations | 8 / 0 | 12 / 0 | **13 / 0** (R11 over all scoped logic files + `.then`; R13 singleton peers) |
| Separation | single-writer / domain hits in views | 0 / 2 | 0 / 0 | **0 / 0** |
| Independence | cross-bundle edges / violations; package graph | 53 / 0 | 52 (36) / 0; 35 pkgs, 124 edges | **52 (36) / 0; 35 pkgs, 124 edges, 85 of them peers** |
| Independence | a faulty bundle's renderer or model | — | blanks the whole shell (I1, R1) | **contained**: shown failed, logged, in coverage; everything else renders (× 2 technologies) |
| Independence | a second kernel copy | — | silent (two worlds) | **refused** at its first `getSlots` |
| Composability | second technology: logic files / UI LOC; hosts | 0 / 791 | 0 / 453; React 267, Solid 180 | **0 / 502; React 334, Solid 229** (containment) |
| Correctness | Cancel during a hung Save | — | trapped (A1) | **closes at once**; Save reported when it lands |
| Correctness | Toggle behind 3 queued Adds (100 ms backend) | — | ≥ 350 ms (B1; 402 measured) | **< 150 ms** |
| Correctness | suites | green | 212 node / 31 Chromium | **228 / 33** — + containment × 2, drain seams 10, dispatcher rewritten (12), singleton, R13, A1, A7, B1, ask refusal |

## P5.2 iteration

A short follow-up to the [re-check after P5.1](../../../../../docs/sandbox-apps/architecture/prototypes/P5-analysis.md)
(section "Re-check after P5.1"), on branch `spike/p5-iteration-2`, in place. It covers the three
new Low hazards N1–N3 and the "two answers" residual. Each item's test was written first and
failed for the stated reason, then the fix made it pass. The documented limits (timers and
listeners, the stale base A7b, Cancel not cancelling the write) are out of scope and unchanged.
Tests: `pnpm test` **231** (228 + 3), `pnpm test:browser` **33** (the containment test now
asserts the new message), and `pnpm typecheck`. No new dependency.

| # | Item | Built as | Test |
| --- | --- | --- | --- |
| N1 | A drain's claim was permanent | `claim()` returns `release`. The drain releases it once its session has closed and every record accepted before the close is settled, or when the bundle scope closes. A drain handles only the records it accepted, and records accepted after its session closed belong to the next drain. A new drain also starts on the records already pending, because otherwise a leftover record would keep a non-queue action `running` forever. | `drain.test.ts`: session A drains and closes, then session B drains without throwing; two open drains still throw; the claim holds while A's record runs, and the leftover record goes to B |
| N2 | `each()` kept one disposer per finished stream | It keeps the `release` returned by `defer` and calls it in a `finally` when the stream ends or throws. When the scope closes, the dropped continuation never runs the `finally`, and the disposer runs as before. | 50 finished streams and 1 throwing stream leave **0** pending disposers (was 51) |
| N3 | The dev guard said "r returns a new value…" | The React host puts `ContributionName` (`<slot> "<id>"`) around each contained contribution, and `useModel` prefixes its error with that name. `readable()` now keeps the wrapped getter's name instead of `r`. | `containment.test.tsx`: `shell:panels "bad:unstable": a getter returns a new value on every call (model contract point 7)`, with a `readable()`-wrapped getter |
| — | Two answers: the first contributed won silently | `answer(slots, decl, by, fn)`. A second answer throws at contribution time: `<key> is already answered by "<a>"; "<b>" cannot answer it too`. The refused answer is not contributed, and once the first is withdrawn another bundle may answer. `observe` is unrestricted. | `commands.test.ts`: the "first answer claims, second never runs" test became the loud-conflict test |

Findings:

1. **No bundle relied on shadowing.** Every command in the app has exactly one answer, and the
   whole suite passes with the conflict check. The only test that relied on it was the kernel's
   "a second answer never runs", which now pins the throw instead.
2. **Naming the contributor needed an argument.** Slots do not know who contributes, and
   `answer` has no bundle scope, so `by` is explicit (the bundle id at 8 call sites). It goes
   before the handler: as the last argument, biome expanded every multi-line `answer` call, which
   cost +37 logic LOC for nothing. In the chosen position the cost is +2 LOC.
3. **Releasing a claim changed who handles leftover records.** Before, a record was handled by
   the one drain that ever existed. Now it is handled by the drain that holds the claim when the
   record is accepted, or by the next drain to claim it. That is why a drain now starts on
   records that are already pending.
4. **N3 needs the host's cooperation.** A binding cannot know which contribution it renders. The
   host already wraps each contribution in a boundary, so it passes the name through a context.
   Solid has no equivalent guard, so nothing changed there.

LOC, counted as in P5.1 (`node scripts/loc.mjs`):

| | P5.1 | **P5.2** |
| --- | --- | --- |
| kernel | 470 | **476** (+6: the conflict check) |
| kernel + `shared-slots` | 679 | **685** (≤ 700) |
| kits | 1010 | **1036** (+26: `kit-commit` 234 → 257, `kit-react` 53 → 55, `kit-signals` 44 → 45) |
| logic | 1219 | **1221** (+2: one `answer` line wrapped) |
| UI (React host) | 334 | **338** (the name provider) |

