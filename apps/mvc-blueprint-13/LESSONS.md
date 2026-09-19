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
