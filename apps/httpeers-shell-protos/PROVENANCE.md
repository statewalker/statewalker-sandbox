# Provenance

What in this app is **recovered code**, what is a **reconstruction from a note**, and
what neither — restored 2026-09-04 from the Drive session
`notes/drive/2026-09-02.Httpeers-Shell/`.

The distinction is load-bearing and is never blurred here: recovered code is evidence
of what the September ladder did, a reconstruction is only evidence of what its notes
say. Every file carries a header saying which it is.

## Why some rungs had to be rebuilt

Four of the eleven Drive archives **do not decompress**. Note 39 predicted exactly
this — *"binary uploads to Drive proved unreliable at these sizes; source uploaded as
text worked every time. Some archives exist only locally."* The local copies no longer
exist; the whole machine was searched. `09-prototype-01-headless-host.tar.gz` yields
its `package.json`, README and rolldown config and loses all of `src/`;
`14-prototype-05-activation-events.tar.gz`, `26-prototype-04a-zod-static-schema.tar.gz`
and `26-prototype-Z-static-schema-derivation.tar.gz` yield nothing at all.

Separately, the tests for rungs 6, 7, 7a, 7b and 9 were **never uploaded**:
`lib/ORIGIN.md` refers to `layout.test.ts` and friends as living "in the local
archive, not uploaded individually". Their code survives in `shell-core`; their
71 tests do not.

## Per rung

| Rung | Code | Tests | Count |
|---|---|---|---|
| `01-headless-host` | reconstructed — notes 10, 11, 03, 06, 07 | written fresh | 85 |
| `02-a2ui-renderer` | `lib/` | recovered (1 assertion corrected) | 16 |
| `03-a2ui-binding` | `lib/` | recovered + 4 reconstructed + 5 audit | 26 |
| `04-manifest-generation` | **recovered**, byte-for-byte | **recovered**, assertions unmodified | 9 |
| `05-activation-events` | reconstructed — note 16 §3 | written fresh | 15 |
| `06-same-module-any-host` | `lib/mount.ts` | written fresh | 14 |
| `06a-tailwind-build` | **recovered**, byte-identical (sha-verified) | none — a build-and-measure rung | — |
| `06b-basecoat-mapping` | `lib/` | recovered (1 corrected) + reconstructed | 24 |
| `07-dockview-hosting` | `lib/dock.ts`, `lib/theme-bridge.ts` | written fresh + 8 audit | 49 |
| `08-biscuit-enablement` | **recovered**, one audited correction | **recovered**, all 23 unmodified, + 10 | 33 |
| `09-apps-from-peers` | `lib/peer.ts` | written fresh | 22 |
| `Z-static-schema` | reconstructed — note 29 | written fresh | 21 |

**314 tests, 26 files.** `lib/` is `code/shell-core/` verbatim and was not edited.

Where a count differs from the September record, it is a **different suite, not a
continuation**, and the rung README says so. Rung 01 replaces 40 tests with 85; rung
05 replaces 9 with 15 because note 16 states ten contract claims that nine tests
cannot span, and nothing records which nine the original chose.

## Two archived assertions were corrected, both stale

Both encode a model rung 7 later disproved — the drift `ORIGIN.md` describes as
invisible while the copies are isolated, and a failure the moment they meet.

- **Rung 02**, "renders a button with its label child": asserted
  `data-variant="primary"`. Rung 2's renderer echoed the message's variant verbatim;
  `lib/basecoat.ts` omits the attribute for primary, per note 32's table.
- **Rung 06b**, "maps each button variant to a distinct Basecoat class": asserted three
  distinct class strings. Verified against the shipped `basecoat-css@1.0.2` —
  `btn-secondary` and `btn-destructive` exist only in the *compat* stylesheet, while
  `.btn[data-variant=…]` is what the real pack styles.

Both originals are quoted verbatim at their sites. The 6b replacement is **stricter**
than what it replaced.

## Open defects in `lib/`, found by restoring the rungs

Pinned by tests that assert the **current** behaviour, so each will turn red when
fixed — deliberately, so a fix cannot land silently.

> **Audit 2026-09-10: two of the recorded holes were NOT pinned.** The sentence above
> was true of the eight defects below and false of `lib/ORIGIN.md`'s own "Known holes"
> list. The first two entries there — *a binding bypasses enum validation*, and
> *reconciliation is O(tree) per update* — existed only as prose in `ORIGIN.md`,
> `03-a2ui-binding/README.md`, defect 5 below, and one `KNOWN HOLE:` comment in
> `lib/renderer.ts`, with **no test of any kind**. Track SH's work order requires them
> carried as failing or explicitly-pending tests rather than silently inherited, and
> they had been silently inherited: a green run mentioned neither.
> `03-a2ui-binding/tests/known-holes.test.ts` now pins both, in the style of this
> section — current behaviour asserted, so closing either hole turns it red. Neither is
> fixed. Verified mutation-sensitive: closing the enum bypass fails two of them,
> adding a path-to-component dependency check fails another.
>
> The O(tree) hole is measured rather than timed — a counting catalogue records that
> one `updateDataModel` re-validates 6 components in a 6-node tree and 51 in a
> 51-node one, and that a write to a path **nothing is bound to** still re-validates
> all 21 of a 21-node tree. Nothing races.
>
> The other four entries in `ORIGIN.md`'s list (`theme` accepted and ignored, no
> `watchDataModel` modes, unnamespaced action names, unversioned layout format) remain
> prose-only and are **not** covered by this pass.

1. **`createAppHost` accepts `onAction` and ignores it.** Actions are wired at renderer
   construction, which only `mountStandalone` does; `lib/dock.ts` builds each pane's
   renderer with no options. A module in a Dockview pane renders and holds data
   correctly and **its buttons are dead**. (06, test 11)

   Documenting the signatures sharpened the diagnosis: `createAppHost` takes
   `(renderer, surfaceId, catalog, options)`, so the renderer already exists by the
   time the host does and `onAction` is *structurally* unhonourable there — a field on
   the wrong type, not an omission in a function body. So this is **one fix in two
   halves, not a choice between two**: `AppHostOptions` shrinks to `{ onNotify }`, and
   `createShellDock` grows a real seam that forwards `RendererOptions` into its
   `createRenderer` call — which amounts to restoring the `dock.mountApp` note 33
   describes and consolidation dropped. Removing the field is the half that must come
   first, because while it stands the type asserts a capability that cannot exist.
2. **The note-35 theme bug is still present.** `lib/dock.ts` hard-codes
   `theme: themeLight`, so Dockview writes its own class on the inner `.dv-shell` — a
   nearer ancestor of pane content than the host — and the bridge class always loses.
   `lib/theme-bridge.ts` never exports the `shadcnTheme()` helper note 35 introduced as
   the fix. The session found this bug, wrote the fix in a note, and the fix never
   reached the consolidated code. (07, claims 30/31)
3. **`ShellDock` cannot be re-themed after construction**, so the dark-mode hole cannot
   be closed by a caller. `dockview.updateOptions({ theme })` works — a missing method,
   not a Dockview limit. (07)
4. **Typography was left behind by finding 5.** Layout moved to shell-owned classes
   because the prebuilt pack has no Tailwind utilities; `Text` still emits `text-sm`,
   `tracking-tight` and friends, which that pack does not define. Variants are distinct
   but **unstyled** on the zero-build path. (06b, test 20)
5. **The enum hole is wider than `ORIGIN.md` records.** It says a binding may resolve
   to a value the catalogue forbids. In fact `validate()` iterates only over the props
   the catalogue *declares*, so a component may carry arbitrary **undeclared**
   properties and they are accepted without comment. This is safe today only because
   `build()`/`apply()` never read `class`, `className` or `style` from a message — an
   invariant of those two functions, not something validation enforces. For a surface
   authored by a foreign peer that is a materially weaker statement than the recorded
   one. (Found while documenting rung 02/03's API surface.)
6. **`handle` fails silently in two places**: `deleteSurface` for an unknown surface is
   a no-op, and a message with none of the four keys set is ignored entirely. There is
   no "unrecognised message" error, so a typo'd key is invisible on a boundary that
   otherwise throws on everything.
7. **`dataModel(surfaceId)` returns the live object, not a copy.** A caller mutating it
   corrupts the surface, and because `writePath` is copy-on-write any retained
   reference silently goes stale.
8. Minor: `fromJSON` recovers origins twice, so no test can tell which path supplied the
   value; and `mountPeerApp` ships the whole `dataModel` snapshot back with every
   action — defensible, since it is the peer's own surface, but undocumented.

## Corrections to the notes

Found by implementing what they say. The prose is wrong in every case below; the code
was right in every case **but one** — see the superseding 2026-09-10 entry under note 18,
which is the single place in this app where recovered source was corrected.

- **Note 18 §5's performance figures do not reproduce, and the finding is worse than
  recorded.** "The Biscuit Authorizer is single-use" is a *timing artefact*: cold, the
  second `query()` fails 10/10; warm, it failed 1/200. So reuse passes its own tests on
  a warm engine and fails on a user's first click. The thrown value is also **not an
  `Error`** — a bare `{"RunLimit":"Timeout"}`, so `e.message` is `undefined`. Measured
  cost is ~0.28 ms/eval and 8.3 ms per 30-entry menu against the recorded 0.586/17.6 —
  faster absolutely, but the stub sped up more, so the ratio widened from ~8× to ~44×.
  The "caching is required" conclusion survives on the ratio, not on the 17.6 ms.

  **Superseded 2026-09-10 by the Track SH audit. THREE statements of this one
  observation exist and TWO OF THEM ARE WRONG.** Both wrong ones are durable records
  that a later reader will find first, so they are named here explicitly:

  1. **WRONG** — note 18 §4.1, repeated verbatim as the work order's SH-3: *"the
     Biscuit `Authorizer` is single-use — a second query fails with a timeout rather
     than a misuse error."* Single-use implies rebuilding per query is a **complete**
     fix. It is not one.
  2. **WRONG** — the correction immediately above, this app's own first attempt: a
     cold/warm timing artefact, with the per-query rebuild "unchanged and better
     justified". The rebuild resets the budget and **cannot bound a single slow
     query**, which is the case that actually fails.
  3. **Correct, below** — a cumulative wall-clock budget across the instance.

  That two different explanations of the same observation were both wrong is itself
  the lesson: each was inferred from *when* the failure appeared rather than from what
  the engine charges, and each looked sufficient because the machine that ran the
  tests was never the machine under load. `08-biscuit-enablement/tests/constraints.test.ts`'s cost test
  went red with a bare `{RunLimit:"Timeout"}` thrown from `evaluate()` on a *fresh*
  authorizer, reproducible on a machine loaded to 3× its cores. What is actually true,
  all of it measured in that file:

  - `query(rule)` charges elapsed time against a budget that is **cumulative across
    the Authorizer instance** and trips permanently once spent. Warm, one instance
    answers ~430 successive queries over a 20-fact world and ~24 over an 8,000-fact
    one — the budget tracks **work**, so it is neither a use count nor a cold/warm
    artefact. Cold simply spends the whole budget inside the first query, which is
    what made note 18 read it as structural.
  - the budget is **wall clock**, which a descheduled thread spends without doing
    work. Under 3× load a query whose median is 0.033 ms measured a p99 of 12 ms and a
    maximum of 53 ms. So rebuilding per query resets the budget but cannot make
    `evaluate()` total, and the failure lands as an uncatchable bare object.
  - the remedy is in the API the rung already used and no note found it:
    `Authorizer.queryWithLimits(rule, limits)`. **But not for the obvious reason** —
    the limits argument is *inert* for queries in `@biscuit-auth/biscuit-wasm@0.6.0`
    (`{}`, `{nope:1}` and `max_time_micro: 1` all behave identically; `null` throws).
    What the call buys is a door that does not charge the cumulative budget: it
    answers on an already-exhausted instance and survived 60,000 successive queries.

  `src/biscuit-enablement.ts` is therefore **recovered with one correction**, the only
  edit to recovered source in this app: both query sites now go through
  `queryWithLimits(…, RUN_LIMITS)`. The archive's own text for every changed line is
  quoted in place. The per-query rebuild **stays** — three recovered contract tests
  plus two of the new ones fail if it is hoisted. The trade is recorded rather than
  hidden: query evaluation no longer has an engine-side runaway guard, which is
  acceptable here only because `CLAUSE` validation stands in front of `evaluate()`,
  `query`/`queryAny` take shell-authored source, and `matchesTerm` binds untrusted
  values as parameters. Widening the `when` grammar, or admitting foreign rule
  *source*, takes that absence on.

  Two further corrections to this app's own record, from the same audit:

  - rung 08's README says of the cost test "**Fails if**: Nothing — this test is not
    allowed to fail on a timing threshold." It was not allowed to and it did, because
    the implementation it measures can throw. "Its assertions cannot race" is not the
    same claim as "this test cannot fail".
  - the README's "the test has never flaked" was true of the claim and false of the
    harness. **Three** tests in `constraints.test.ts` failed under 3× CPU
    oversubscription, not one, and only one of them was the reported red. Named,
    because a test that passes idle and fails under load is a CI time bomb:

    | Test | Why it failed under load | State now |
    |---|---|---|
    | `the cost of substitution › records the per-evaluation and 30-entry menu cost` | the *implementation* threw mid-measurement — the reported red | **deterministic.** Fixed in the code, not the test. Its own assertions never raced: a finiteness check and an 80 ms tripwire (biscuit measured 1.949 ms/eval even under 3× load) |
    | `reusing an Authorizer › stops failing once the engine is warm` | the **first** query sat outside the `try`, so its timeout escaped as a test error instead of being counted | **deterministic.** Counted now, and it asserts only the *shape* of whatever failures occur, never a rate |
    | `reusing an Authorizer › fails in a cold process` | same escaping first query, in the child process — its *precondition*, never its claim. 23/30 clean first queries under 3× load | **bounded, not absolute.** A run whose first query timed out establishes nothing and is retried up to 4 times; the claim itself measured 30/30 idle and 30/30 under load. Residual ≈0.06% (5 consecutive precondition failures at the observed 23% rate) |

    A fourth, added by this audit (`the run limit is a cumulative budget › is spent
    across many queries`), flaked on its first draft — not on its assertion but on
    vitest's 5 s timeout, because building six 8,000-fact worlds costs more than the
    rest of the file. Rebuilt against a 20-fact world; 8/8 green under 3× load, counts
    34–119, and it asserts the **maximum** over trials because falsifying "single-use"
    needs one witness, not an average — a per-trial floor there would have been the
    same wall-clock race the file warns about.

    No assertion was weakened anywhere. The whole file is 8/8 green under the load
    that produced the original red.
- **Note 29's "counterintuitive result" is a mis-comparison.** Its 22 KB-built vs
  12 KB-prebuilt sets the full style pack against the *bare* pack, which has no
  `data-variant` selectors at all. Like for like: 22,158 vs 21,867 bytes — **1.3%, not
  45%**. Shipping prebuilt still wins, on the build step rather than the bytes.
- **Note 29 contradicts itself**: the prose says three tests failed on first run, the
  table lists two. The third is unrecorded and cannot be confirmed reproduced.
- **Note 24's reconciliation contract is out of date** — "an element is rebuilt only
  when the component type at that id changes" was disproved by 6b, since `Text`'s
  variant selects the tag.
- **Note 16's recognition rule 3 is backwards**: the policy is the *innermost* chain
  link, not the outermost.
- **Note 31's "CSS never injected"** is true of the ESM entry, false of the standalone
  build, which appends a `<style>`.
- **Note 35/38 understate the `colorScheme` hole**: in Dockview 8.2.0 it is **never read
  at all** — all 18 occurrences are object-literal keys. It is advisory metadata the
  embedder must act on.
- **Note 39 undercounts `.int()`** — Zod also emits `minimum: -9007199254740991` — and
  an explicit bound *replaces* rather than narrows that range.
- **Note 06's `--experimental-wasm-modules` claim is stale**, as note 18 §3 already
  said: `biscuit-wasm` imports with no flag on Node v24.8.0.
- Rung 05's "a plain synchronous return does not claim a command" is enforced by the
  shipped `@statewalker/shared-commands` bus, not by the host — rung 5 *inherits* the
  property rather than establishing it.

## What this app still does not establish

Restoration does not close the ladder's gaps, and note 38 remains the honest inventory.
The sharpest, carried in rung 09's README: the catalogue bounds *what* a peer may
express, and **nothing checks whether a peer may serve you an application at all**. A
test mounts an app from an entirely unknown peer, asserts it renders, and asserts at the
API surface that `mountPeerApp` has no parameter through which a capability could be
supplied — passing by demonstrating the absence, so a green run cannot be read as
covering it.

Nothing here is a browser test. `lib/browser-states.mjs` is **not runnable**: it needs
undeclared Puppeteer plus a Chromium download, a `dist/states.html` fixture that does
not exist, and defect 2 fixed first. Note 39 records that the 7b theme bridge passed
every unit test and did not work in a browser — and happy-dom resolves **no** CSS custom
property from a stylesheet, so the assertion class that failure lived in is unavailable
here. Rung 07's README says so, and a test enforces it.

**Audit 2026-09-10 — this claim survives intact, and is now asserted rather than
written down.** The harness was *copied*, not ported, and Track SH's work order asked
for it ported in this unit. Five independent reasons it cannot run, each now a test in
`07-dockview-hosting/tests/browser-harness.test.ts`: no `test:browser` script exists
though the file's own header names one; `puppeteer-core` and `@sparticuz/chromium` are
imported and declared nowhere; `dist/states.html` and `dist/` do not exist and no script
builds them; `window.__dock` is read and assigned nowhere in the app; and the file is a
`.mjs` outside `tests/`, which `vitest.config.ts`'s `include` cannot match by extension
or by path. Every one of those assertions inverts when the harness is wired up, so the
gap now has to be closed through that file rather than remembered.

**It was not wired up, deliberately, and the scope is the reason.** Beyond the two
dependencies and the Chromium download, `dist/states.html` needs a browser bundle of
`lib/dock.ts` and `lib/theme-bridge.ts` — TypeScript, so a bundler this app does not
configure; `06a` runs the Tailwind CLI and nothing else. And defect 2 must be fixed
first: `lib/dock.ts` hard-codes `theme: themeLight`, which **is** the note-35 bug, so
the harness's central assertion — that the drag overlay's colours flip between light and
dark — cannot pass until `lib/` is repaired, and rung 07's tests deliberately pin that
line. It is a unit of work coupled to a fix outside this one's scope, not a loose end.

**READ THIS BEFORE READING THE GREEN NUMBER.** This suite is green *and* structurally
unable to catch the class of defect notes 35 and 36 recorded. Those are not in tension
and the second does not follow from the first being wrong — it follows from what a unit
test can reach. Note 35's bug escaped **61 unit tests**; this app has **314** and
cannot catch that class either, for the same reason, which note 35 states better than
a summary can: *a test that builds its own DOM tests the stylesheet, not the
integration.* Concretely, happy-dom resolves no CSS custom property from a stylesheet
(asserted in `07-dockview-hosting/tests/limitations.test.ts`), Dockview's drag-and-drop
cannot be driven without Chrome's drag interception (asserted in the same file), and
`colorScheme` is never read by dockview-core 8.2.0 at all. So every `--dv-dnd-*`,
`--dv-drag-over-*`, `--dv-smart-guides-*` and `--dv-edge-dock-indicator-*` entry in the
bridge is **unexercised**, and the one assertion that would have caught the original
bug — does the bridge's class reach the element Dockview actually reads — is not
expressible here at all.

A reader who takes 314 green as coverage of the theme bridge will conclude the exact
opposite of the truth. **This app has no evidence about the theme bridge's behaviour in
a browser**, and acquiring that evidence means the browser harness, not more unit
tests.
