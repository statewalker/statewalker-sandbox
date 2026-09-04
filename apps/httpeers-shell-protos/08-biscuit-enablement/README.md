# 08 — Biscuit satisfied the interface unchanged

`pnpm test 08-biscuit-enablement` — 29 tests.

**Question**: does Biscuit's Datalog engine satisfy the `Enablement` interface
unchanged?

**Answer: yes.** The interface was not modified to accommodate it. That is the
whole result: this was a *substitution test*, not a design question.

`src/` is **recovered** from archive
`17-prototype-08-biscuit-enablement.tar.gz`, along with the 23 tests in
`tests/biscuit.test.ts`; each file carries a `RECOVERED-FROM-ARCHIVE` header and
is otherwise verbatim. This is the only rung on the ladder that owns source
outside `lib/` — the Biscuit adapter never made it into the consolidated
shell-core. `tests/constraints.test.ts` is new, written from the notes, and
pins the three constraints the rung paid for on the way to its answer.

## The interface, unchanged

This is rung 1's `Enablement`, from `src/enablement.ts`. Not a line of it moved
to let Biscuit in:

```ts
interface Fact {
  readonly predicate: string;
  readonly terms: readonly (string | number | boolean)[];
}

interface Enablement {
  setFacts(facts: readonly Fact[]): void;
  assert(fact: Fact): void;
  retract(fact: Fact): void;
  evaluate(when: string | undefined): boolean;
  onChange(cb: () => void): () => void;
}
```

`factSetEnablement()` is the stub rungs 1–5 use; `createBiscuitEnablement()`
returns the same interface backed by WASM Datalog, plus three extra members
(`query`, `queryAny`, `matchesTerm`) for the things the stub cannot express.
The extras are *additive*: nothing on `Enablement` changed to make room for
them, which is exactly what "the abstraction was right" looks like.

The suite is built to make a divergence impossible to miss: the same nine
assertions run against **both** implementations through `describe.each`, so a
behaviour either has in one and not the other fails the run.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | Biscuit and the stub agree on the whole `Enablement` contract | Nine assertions × two implementations via `describe.each` — empty `when`, single fact, conjunction, negation, re-evaluation after change, change notification, multi-term facts, whole-set replacement, malformed clause | Either implementation diverges on any of the nine, in either direction |
| 2 | A malformed `when` throws rather than silently disabling a menu entry | `evaluate("selection")` throws in both | A bad clause returns `false`, which is indistinguishable from "the fact is absent" |
| 3 | Biscuit adds **variables and joins**, which the stub cannot express | `allowed($op) <- current_peer($p), right($p, $op)` returns `["read"]` | The join returns nothing, or the rule fails to parse |
| 4 | Biscuit adds **disjunction**, through multiple rules | `queryAny` over two rules is true when either matches, false when neither does | Either branch is not consulted |
| 5 | An **untrusted term cannot inject Datalog** | `matchesTerm("selection", 'file") or true or selection("')` is `false`; the value binds as a `{param}` placeholder, and only the trusted predicate is part of the rule source | The hostile value alters the rule and returns a result |
| 6 | The WASM module loads with **no Node flag** | `loadBiscuit()` resolves with no `--experimental-wasm-modules` anywhere in `execArgv` or `NODE_OPTIONS`; only an `ExperimentalWarning` is printed | The import needs a flag — i.e. the package README is right after all and note 18 §3 is wrong |
| 7 | The load is memoised and is **not** retried on failure | Two `loadBiscuit()` calls return the identical module object | A second call re-imports, which on a missing binary would mean re-failing on every menu render |
| 8 | A rule head must carry **at least one term** | `Rule.fromString('_m() <- selection("file")')` throws; `_m(true) <- …` does not | A zero-term head parses, and every generated rule can drop the `(true)` |
| 9 | A **reused authorizer fails uncatchably**, in a cold process | A child `node` process builds one authorizer and queries twice: the second throws a bare `{ RunLimit: "Timeout" }` **object** — `instanceof Error` is `false` and `.message` is `undefined` | The second query succeeds, or throws something a caller could handle |
| 10 | Rebuilding per query keeps `evaluate()` reliable | Four successive evaluations over one `Enablement`, including a two-clause `when` (two queries inside one call) | The authorizer is hoisted out of `ask()` — mutating that line fails this and three of the recovered contract tests |
| 11 | The cost of substitution is **recorded, on the machine that ran it** | 20 facts, two-clause `when`, 200 iterations after warm-up; both implementations measured and printed with the note's figures beside them | Nothing — this test is not allowed to fail on a timing threshold. Its only assertions are a finite measurement and an 80 ms tripwire ≈135× the note's figure |

## Two things the notes got wrong

**The Authorizer is not single-use.** Note 18 §4.1 calls this the rung's most
important discovery, and it half reproduces. In a **cold** process a second
`query()` on the same authorizer fails `{RunLimit:"Timeout"}` — 10 times out of
10. Once the engine is **warm** it stops failing: 1 failure in 300 in a quick
loop, 0 in 200 in the test, and 0 in 20 even with 5,000 facts in the world.
So this is a wall-clock limit (biscuit's default `max_time` is 1 ms) that a
cold WASM run overruns, not a structural rule about instances.

That is **worse than the note's version, not better**. A hard rule is
discovered the first time you break it. A timing limit means reuse passes its
own tests on a warm engine and fails on a user's first click — and fails by
throwing something that is not an `Error`, so the ordinary
`catch (e) { log(e.message) }` prints `undefined`. The mitigation the rung
chose — one authorizer per query — is unchanged and better justified.
`tests/constraints.test.ts` therefore pins the cold case in a child process
and *records* the warm rate without asserting it.

**The performance figures do not reproduce.** Note 18 §5 measured 0.586 ms per
evaluation, 17.6 ms for a 30-entry menu, ~8× the stub, and concluded that
17.6 ms exceeds a 16.7 ms frame budget. On this machine (Node 24.8.0):

| | per evaluation | 30-entry menu | vs stub |
|---|---|---|---|
| note 18 §5 | 0.586 ms | 17.6 ms | ~8× |
| here | ~0.13–0.20 ms | ~3.9–6.1 ms | ~40–60× |

Biscuit is roughly 3× *faster* in absolute terms and the 30-entry menu fits
inside a frame — but the stub got ~20× faster too, so the **gap widened from
8× to about 50×**. The conclusion "cache the results" survives both
measurements, and the ratio is the part that travels between machines. The
absolute frame-budget claim does not: quoting 17.6 ms as a fact about this
code would be wrong.

## Not covered here

- **No Biscuit tokens.** No delegation, no attenuation, no signature
  verification. Only the Datalog engine is exercised — `buildUnauthenticated()`
  means there is no token in the authorizer at all.
- **No caching.** Note 38 §4 lists enablement caching as required rather than
  optional. The `onChange` hook it would hang off exists; the cache does not,
  and nothing here measures one.
- **No browser measurement.** All figures are Node. The 2.35 MB WASM payload is
  the npm artefact, not a gzipped browser download, and no rung has paid it in
  a browser.
- **Nothing consumes this behind a UI.** `loadBiscuit()` memoises, but no menu
  ever lazily loads it.
- **The `when` grammar is still the stub's.** Biscuit can do far more;
  widening the grammar would end the stub's career as a fallback, and that
  trade-off is unexamined.
- **Fact lifecycle is undesigned.** Nothing decides who asserts
  `selection("file")`, or when.
