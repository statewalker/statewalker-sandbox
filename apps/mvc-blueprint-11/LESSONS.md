# P3 — commit mechanisms: lessons

Prototype **P3** (`apps/mvc-blueprint-11`): P0 with the commit mechanism varied three ways on the
same flows: **A** controller snapshot (P0), **B** form `commit()`, **C** action-bound commit records.
Status: **DONE**. All three pass the same extended race suite, the P0 suites and the e2e scenarios.
**Recommendation: C.**

## History

| Commit | What |
| --- | --- |
| `ae3c34a` | copy of P0 as the base (150 node tests green) |
| `85b5ffe` | `@kit/mechanism`, `@kit/commit`; `a/ b/ c/` for contacts.edit, todos.rename, todos.list, todos.clear-completed; multi-step Save; the race suite per mechanism |
| `a26ed11` | contract + single writer on B and C, kit tests, wrong-usage mutants, e2e per mechanism, `?commit=` |

Tests: node **304** (node-A 222: the P0 suite + P3's; node-B 41 and node-C 41: commits, races,
dispose, late, standalone, removal). Chromium **44** (10 scenarios × React A/B/C + DOM A, 2
standalone, 2 flush). Stable over 3 consecutive runs.

## What worked

1. **All three satisfy ADR-012 on every flow.** The same race suite (15 races + P0's 9 commit tests)
   passes on A, B and C: typing in the same tick and while running (Save, Rename, Add), a selection
   changed after Delete, two submits in one tick (one commit for Save/Rename/Delete, two queued for
   Add), a submit while running (refused visibly / queued), a **multi-step** Save (async validation,
   then update; typing during step 1 and during step 2 is not committed), cancel during a running
   save and during a failing one, dispose during step 1 of a save, dispose with three Adds queued.
   The rule is mechanism-independent, as ADR-012 says.
2. **C removes the commit plumbing from controllers.** C controllers have 0 `running` writes, 0
   `??=` folds, 0 `onSubmits`, 0 update loops, 0 `settle` calls and 0 `session !== s` checks
   (A: 10 / 5 / 10 / 4 / – / 3). Commit-handling code per bundle becomes one `drainCommits(…, on(action,
   handler), …)` whose handler receives the snapshot as its argument. Controller LOC −23 % vs A.
3. **C closes P0's same-tick hole by construction.** `running` is derived from "a record is
   unsettled" and flips inside `submit()`; a second submit in the same tick is refused by the
   action. Test: `running` is visible in the submit's own tick on B and C, a microtask later on A.
4. **C makes the wrong things unwritable, not just testable.** Writing `running` is a type error
   (`CommitControl.update` omits it); forgetting to settle is impossible (the drain settles in
   `finally`); mutating a snapshot throws (deep-frozen); forgetting the `??=` fold cannot be written.
5. **C reaches data that is not in a form.** `capture` is any synchronous read: the form's draft
   (Save, Rename), the list's selection (Delete, Toggle, Edit), another bundle's collection (Clear
   completed: the ids done *at submit*), another bundle's selection (Rename…). One mechanism for all
   commits.
6. **C expresses "running until the dialog is answered" with no writes.** Clear completed's handler
   awaits the dialog's answer; the record stays unsettled, so the action is `running` (and refuses)
   exactly as long as the dialog is open. In A this needs a `running: true` in `ask()` and a
   `running: false` in `close()`.
7. **Commit order across actions** (R2's "commit time is mailbox order"): `drainCommits` handles the
   records of all its actions one at a time in `seq` order. Cancel submitted during a running Save
   is handled after the Save, in every mechanism, without a special case in C.
8. **Neither B nor C breaks the model contract or the single-writer rule.** The new groups — B's
   commit group and derived Save state, C's records group and action state — pass MODELS.md §4
   points 1–8. Single writer holds by splitting the queue into two fields: the records/commit (writer:
   the view, via `submit`) and the settled cursor (writer: the controller, via `settle(seq)`);
   `running` is derived from both. Type-level checks over 8 B/C control facets: 0 violations.

## What failed, or did not deliver

1. **B does not stay B.** For one-field forms (Contacts, Rename) B is ≈ 30 lines per form: a commit
   group, a settled cursor, and a re-implemented Save view whose `running` is derived. The list (four
   actions, one queued) needed a local generic helper `committing(action, capture, queue)` — which is
   C's primitive, written privately inside one model. Every B form re-implements an action.
2. **B has no place for commits whose data is not in a form.** Clear completed acts on another
   bundle's collection, "Rename…" on another bundle's selection, the contacts link on
   `contacts:selection`: no form of the committing bundle owns that data. They stay controller
   snapshots (A). `todos.clear-completed/b` simply re-exports `a`. **An app on B runs two mechanisms.**
3. **B leaves a dead writer.** The form ORs its pending commit into Save's `running`, but Save's inner
   `ActionControl.update({ running })` still compiles and is silently masked. C removes the field
   from the control type.
4. **No mechanism catches "re-read the draft in the handler" by type.** The controller creates the
   form, so it can always reach `view.getDraft()`. In all three, only a race test catches it
   (`tests/mechanisms/wrong-usage.test.ts`). C makes the right value the *argument* of the handler,
   so the wrong read is a visible detour rather than the default — but it compiles. A lint could not
   tell it from the legitimate read in Add ("clear the input only if it still holds what was
   added"), which compares with current state on purpose.
5. **C does not solve disposal.** Handlers still check `if (!active) return` after each await (5 in
   C, 6 in A). R3's kernel-enforced "no append after stop" is out of C's reach; C's drain only
   stops *starting* handlers.
6. **Clear completed has two entry points in C.** The `todos:clear-completed:ask` command opens the
   dialog without a record, so the toolbar action is not `running` while that dialog is open; a
   toolbar submit then records and waits on the open dialog (visible as running). A never-lost
   outcome, but not identical to A.

## Pros and cons per mechanism

| | Pros | Cons |
| --- | --- | --- |
| A | no new concept; the model contract untouched; controllers see everything | per-controller plumbing (fold, `running` writes, loop); same-tick hole needs `??=`; every wrong usage compiles |
| B | the draft is captured where it lives; `running` derived; same-tick refusal in the form | per-form re-implementation of an action; no reach beyond the form → two mechanisms per app; a dead `running` writer |
| C | one kit primitive for every commit; handler gets the snapshot as argument; `running`, refusal, queueing and settlement by construction; least controller code | a new kit (161 LOC); records are one more group on the control facet; the action's control type differs from `ActionControl` (menus and toolbars still take the unchanged `ActionView`) |

## Numbers

LOC (non-blank, non-comment; `scripts/loc.mjs` rules) of the four varied bundles.

| Bundle | A controller / model | B controller / model | C controller / model |
| --- | --- | --- | --- |
| contacts.edit (Save multi-step, Cancel) | 130 / 87 | 128 / 121 | 101 / 92 |
| todos.rename (Rename…, Rename, Cancel) | 134 / 60 | 132 / 90 | 103 / 60 |
| todos.list (Add queued, Toggle, Edit, Delete) | 138 / 145 | 108 / 219 | 90 / 171 |
| todos.clear-completed (ask, Clear, Cancel) | 146 / 25 | 146 / 25 (= A) | 126 / 27 |
| **total** | **548 / 317 = 865** | **514 / 455 = 969** | **420 / 350 = 770** |
| kit | loop 77 + action 78 (P0) | same as A | + `@kit/commit` 161 |

Controller: B −6 %, C −23 %. Model: B +44 %, C +10 %. Logic total: B +12 %, C −11 % (+161 kit LOC,
shared by every bundle). Tests: races 260 LOC (shared by all three), commit-mechanisms 244 (B and C),
wrong-usage 174 (shared 22 · A 60 · B 41 · C 51).

Constructs in the four controllers:

| | `running` writes | `??=` folds | `onSubmits` | update loops | `settle` | `session !== s` | `if (!active` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 10 | 5 | 10 | 4 | – | 3 | 6 |
| B | 3 (the A-bundle) | 2 | 6 | 4 | 3 (+3 `finally`) | 3 | 5 |
| C | 0 | 0 | 0 | 0 | 0 | 0 | 5 |

Concepts (P0 counts 26): **A 26**. **B 27** — "form commit + settle" is added, and concepts 24 and
25 stay for every non-form commit. **C 26** — concept 24 becomes "a commit is a record the action
captures at submit; a controller drains and settles it" and concept 25 becomes a declaration
(`queue: true` or refuse); concept 19 ("no payload") becomes "no payload on the view facet". The
update loop (a kit-only concept) is no longer needed for commits.

Wrong usage (acceptance 3):

| Mutant | A | B | C |
| --- | --- | --- | --- |
| read the draft in the pass/handler | compiles; race test catches | compiles; race test catches | compiles; race test catches |
| `=` for `??=` (second submit overwrites) | compiles; two-submits test catches | cannot be written | cannot be written |
| forget `running: true` | compiles; refuse test catches (2 saves) | cannot be written | cannot be written (type error) |
| forget `settle` / `running: false` | compiles; stuck (not mutated here; any "save again" test catches) | compiles; stuck (mutant; a "save again" check catches) | cannot be written (drain settles) |
| mutate the snapshot | throws for drafts (models freeze them), silent for controller-built snapshots (the list's `{ selection, items }`) | throws (shallow-frozen by the form) | throws (deep-frozen by the kit) |

## Answers to the points to clarify

- **Which mechanism is simplest to use correctly, and which makes the wrong thing hardest?** C on
  both counts: the handler receives the commit as its argument, and four of the five wrong usages
  cannot be written. A makes every wrong usage compile. B sits between, and only inside forms.
- **Where does queue vs disable fit?** A: in controller code (a list vs `??=`, `running` writes).
  B: in each form (a list of commits vs one). C: one option on the action (`queue: true`), with
  `running` derived — the declaration R3 proposed (`whileRunning`), without the log.
- **Does B or C break the model contract or the single-writer invariant?** No, measured. Both need
  the queue split into a view-written list and a controller-written settled cursor; a
  controller-side `take()` that removes the record would have made the list two-writer. B leaves a
  masked `running` writer on Save's inner control.
- **Which mechanism does R3's log make unnecessary, if R3 succeeded?** Both A and B. R3's append
  (clone + freeze at append, outcome records, `running` = "no outcome yet") *is* C, at kernel scope.
  R3 kept its commit benefits and lost on state; C is exactly the part of R3 worth keeping, per
  action, in a 161-LOC kit instead of a 340-LOC kernel log. If R3's log were adopted, `@kit/commit`
  would be a thin view over it.
- **Is a queued commit ever what a user wants in these forms?** For Add, yes: rapid entry, each
  title its own todo, input free while earlier ones land. For Save and Rename, no: a second Save of
  the same record while the first is in flight is either a duplicate or a race on the same record,
  and a successful Save closes the form the queued commit belonged to. For Delete, no: a queued
  delete of a later selection would surprise. Refuse for record edits; queue for event-edge inputs —
  P0's recommendation stands.
- **Does B require a form facet the view should not have?** No: the commit group and `settle` are
  on the control facet, and the view keeps `save: ActionView`. But the form must re-implement its
  Save *action* (to derive `running` and refuse), so B moves an action concern into every form.

## Recommendation for consolidation

Adopt **C** as the commit mechanism of the definition, and amend ADR-012 from "mechanism open" to:

1. An action's view facet stays payload-free (`submit()`); an accepted submit appends a
   **commit record** `{ seq, snapshot }` whose snapshot is captured synchronously by the action and
   deep-frozen. The capture is declared where the action is created (model or controller).
2. `running` is **derived** (a record is unsettled) and not writable; refuse is the default,
   `queue: true` declares an event-edge action. The P0 same-tick fold disappears.
3. A controller consumes records with a serial drain in commit order and never settles by hand.
   Records (view-written) and the settled cursor (controller-written) are separate fields.
4. Keep the race suite (15 races + the P0 commit tests) as the correctness gate; it is the only
   thing that catches a handler that re-reads the draft.

Drop B. Keep A only as the explanation of what C automates. Pair C with a disposal guarantee from
elsewhere (R3's "no write after stop", or P2's controller shape): C removes the commit plumbing but
not the `if (!active)` checks.
