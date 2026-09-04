# 08 — Biscuit satisfied the interface unchanged

`pnpm test 08-biscuit-enablement` — 29 tests.

`src/` is **recovered** from archive
`17-prototype-08-biscuit-enablement.tar.gz`, along with the 23 tests in
`tests/biscuit.test.ts`; each file carries a `RECOVERED-FROM-ARCHIVE` header and
is otherwise verbatim. This is the only rung on the ladder that owns source
outside `lib/` — the Biscuit adapter never made it into the consolidated
shell-core. `tests/constraints.test.ts` is new, written from the notes, and
pins the three constraints the rung paid for on the way to its answer.

## Goal

**Question**: does Biscuit's Datalog engine satisfy the `Enablement` interface
unchanged?

**Answer: yes.** The interface was not modified to accommodate it. That is the
whole result: this was a *substitution test*, not a design question.

### Why it mattered

`Enablement` was built in rung 1 **specifically as the swap point**: the stub
`factSetEnablement()` exists so rungs 1–5 could ship without 2.35 MB of WASM,
on the promise that the real engine would drop in later. This rung is where
that promise is called in.

Mikhail's insight (note 06 §2) is what made it worth testing: httpeers already
replaced JWTs with Biscuit, and Biscuit already evaluates Datalog to decide
whether a delegated peer holds a right. If the same engine can answer `when`,
then "hidden because you lack the right" and "hidden because nothing is
selected" collapse into **one code path over one fact set**, and the shell
carries one policy language instead of two.

**What a "no" would have cost.** A substitution that forced the interface to
change would have meant the abstraction was wrong — and that, not the
substitution, would have been the finding. Concretely, a "no" costs:

- every caller in rungs 1–5 that holds an `Enablement`, because the stub could
  no longer stand in for the real thing and the lazy-load fallback dies with
  it;
- the static-manifest model itself, since `when` is what lets a build-time
  manifest behave dynamically (note 06 §1) — an engine that needs a different
  shape of question pushes enablement back into imperative application code,
  which is the flicker-and-subscriptions world `when` exists to avoid;
- and the single-fact-set claim. Two engines means two vocabularies, and
  authorization stops being a **swap** and becomes a **redesign**.

## Findings

### The interface, unchanged

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

### Verified

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

### Two things the notes got wrong

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

## Techniques and APIs

### The `Enablement` interface

Five members, and every caller in the ladder holds only these:

| Member | What it does |
|---|---|
| `setFacts(facts)` | replace the whole fact set |
| `assert(fact)` / `retract(fact)` | add or remove one fact; fire `onChange` only on a real change |
| `evaluate(when)` | the boolean a menu entry is drawn from; an absent or empty `when` is always enabled |
| `onChange(cb)` | subscribe to fact-set changes, returning an unsubscribe — the hook a cache would invalidate through |

A `Fact` is a predicate name plus terms (`fact("right", "peer1", "read")`),
mirroring Datalog so the stub's vocabulary is forward-compatible with the real
engine. The `when` grammar both implementations accept is deliberately narrow:
a conjunction of ground fact patterns, comma for AND, leading `!` for negation.
Disjunction, comparisons and variables **throw** `Malformed when clause` --
reaching for them is the signal to use Biscuit's own surface instead of growing
the stub into a second policy language.

### The Biscuit surface, added on top

`createBiscuitEnablement()` returns `BiscuitEnablement extends Enablement` with
three additive members:

| Member | What it does |
|---|---|
| `query(ruleSource)` | run a **trusted** Datalog rule, return the first term of each result — this is what expresses variables and joins |
| `queryAny(ruleSources)` | true if any rule yields a result: disjunction, one authorizer per branch |
| `matchesTerm(predicate, value)` | match a predicate against an **untrusted** term bound as a parameter |

`loadBiscuit()` dynamically imports the WASM and memoises the promise. The memo
is deliberately **not** cleared on rejection: a missing WASM binary is not
transient, and retrying on every menu render would be pathological.

### How `@biscuit-auth/biscuit-wasm@0.6.0` is actually driven

No token is involved anywhere in this rung. The engine is used purely as a
Datalog evaluator:

```ts
const builder = new bis.AuthorizerBuilder();
for (const f of facts) builder.addCode(`${f};`);   // selection("file");
const authorizer = builder.buildUnauthenticated(); // no token, no signature
authorizer.query(bis.Rule.fromString('_m(true) <- selection("file")'));
```

`when` therefore becomes a **query** — "does this fact set satisfy this rule"
— rather than an authorization check. Same engine, different question. Four
API shapes are easy to get wrong and all four are pinned by tests:

- the method is `buildUnauthenticated`, camelCase, not `build_unauthenticated`;
- a rule head must carry at least one term: `_m()` is a parse error, `_m(true)`
  is not;
- a predicate **name** cannot be a parameter, only a term — so `matchesTerm`
  invokes the `rule` tagged template with a *synthetic strings array*, putting
  the trusted predicate in the source while the untrusted value binds as
  `{param_N}`. A hostile value like `file") or true or selection("` is then
  matched as a literal string and returns nothing;
- `Rule.fromString` is for trusted source; parameters are for untrusted terms.
  Mixing them up is how injection gets in.

### The `Authorizer` lifecycle, and the per-query rebuild

`biscuit-enablement.ts` builds a **fresh authorizer for every single query**:

```ts
const authorizer = () => {
  const builder = new bis.AuthorizerBuilder();
  for (const f of facts) builder.addCode(`${f};`);
  return builder.buildUnauthenticated();
};
const ask = (src) => authorizer().query(bis.Rule.fromString(src)).map(String);
```

Not per evaluation, and certainly not once. A two-clause `when` is therefore
two builds. That looks wasteful, and the archive justified it with "the
Authorizer is single-use" — which turns out to be **not quite true, in the
direction that makes the rebuild more necessary rather than less**: reuse fails
on a cold engine and succeeds on a warm one (see the corrected finding above).
A hoisted authorizer would pass a warm test suite. Mutating that one line makes
four tests fail, which is the guard that keeps it in place.

### Test techniques worth reusing

**Pin the cold case in a child process; only record the warm one.** The
authorizer-reuse failure is a wall-clock race, so an in-process assertion would
be a flaky test making a claim it cannot support. Instead
`tests/constraints.test.ts` spawns a fresh `node --input-type=module -e` that
builds one authorizer, queries twice, and prints JSON: cold is deterministic
(10/10 by hand, and the test has never flaked). The warm loop — 200 warm-up
reuses, then 200 measured — asserts **no rate at all**. It records the count
to stdout and asserts only the part that never varies: any failure is a bare
object, never a catchable `Error`.

**Measure, print, and assert only a tripwire.** The cost test prints a table
with note 18's figures beside the machine's own and asserts a finite
measurement plus an 80 ms ceiling (~135× the note's figure). A threshold
assertion would be a timing race, and worse, a green run would read as "the
cost is fine" — the opposite of the finding.

**One contract, two implementations, one suite.** The nine contract assertions
run against the stub and Biscuit through `describe.each`, so a divergence in
*either* direction is a failure rather than something a reader has to notice.

### Environment gotchas (both cost real time)

- Under **happy-dom**, `import.meta.url` is not a `file:` URL.
  `fileURLToPath(new URL("../../lib/x.ts", import.meta.url))` does not throw --
  it silently yields a path rooted at `/`, and the test fails with a confusing
  `ENOENT: /lib/x.ts`. Resolve from `process.cwd()` instead.
- Under **happy-dom**, `console.log` goes to the DOM's virtual console and
  **never reaches the terminal**. A measurement logged that way is invisible,
  which defeats the point of a recording test. Use `process.stdout.write`.

## Lessons learned

**"The Authorizer is single-use" is a timing artefact, and it is worse than
the note said.** A hard structural rule is discovered the first time you break
it. A 1 ms `max_time` that only a cold WASM run overruns means reuse **passes
its own test suite on a warm engine and fails on a user's first click** — and
the machine that runs the tests is exactly the machine that is warm. Treat
"works when I ran it" as no evidence at all for an engine with a run limit.

**The thrown value is not an `Error`.** It is a bare `{ RunLimit: "Timeout" }`
object: `instanceof Error` is `false`, `.message` is `undefined`. The ordinary
`catch (e) { log(e.message) }` prints `undefined` and the operator learns
nothing. Any code that catches around a WASM boundary should serialise the
caught value, not read `.message` off it.

**Performance figures do not travel between machines; ratios do.** Note 18's
0.586 ms / 17.6 ms / ~8× became ~0.13–0.20 ms / ~3.9–6.1 ms / ~40–60× here.
Both the absolute numbers and the ratio moved, in opposite directions --
Biscuit got faster, the stub got much faster. The **caching conclusion
survives on the ratio**, not on 17.6 ms: quoting "17.6 ms exceeds a frame
budget" as a fact about this code would be wrong, while "Datalog evaluation
costs tens of times what a set lookup costs, so cache it and invalidate through
`onChange`" holds on both machines.

**`biscuit-wasm` needs no Node flag.** It imports cleanly on **Node v24.8.0**
with only an `ExperimentalWarning`; the package README's
`--experimental-wasm-modules` instruction is stale, as note 18 §3 said and
note 06 §6 had feared otherwise. A test asserts no `wasm` flag is present in
`execArgv` or `NODE_OPTIONS`, so the retraction stays checked rather than
remembered.

**An interface earns its keep at the swap, not at the design review.** The
result here is not "Biscuit works" — it is that a 2.35 MB WASM Datalog engine
and a 90-line `Set` of strings satisfy the *same five-member contract*, with
the differences showing up as **additive** members rather than as changes. That
is the only evidence that rung 1's abstraction was drawn in the right place.

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
