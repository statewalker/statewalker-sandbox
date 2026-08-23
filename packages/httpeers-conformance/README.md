# @statewalker/httpeers-conformance

One test per numbered criterion of the httpeers block API, and a measurement of any
implementation against it.

**Spec:** `docs/superpowers/specs/2026-08-20-httpeers-api-design.md` · ADR-0003

```bash
pnpm test          # the suite's own health: the reference adapter + integrity. GREEN.
pnpm report:gap    # an implementation measured against the spec. RED until reconciled.
pnpm sync-criteria # regenerate the registry after the spec changes
```

`pnpm test` and `pnpm report:gap` are separate on purpose. The gap is a measurement,
not a regression, and a permanently-red `test` is one that gets disabled.

## What it is for

The spec's §13 lists divergences from `httpeers.core` in prose. Prose does not tell
you which of them matter, and cannot tell you when one is closed. This suite turns
that list into outcomes, so a 3,000-line package can be reconciled against a red/green
signal rather than against a document.

It also keeps the spec honest in the other direction: a suite nothing passes is
indistinguishable from a suite whose checks are wrong, so `adapters/reference.ts`
implements the specified behaviour and must stay green.

## Four outcomes, not two

| | meaning |
|---|---|
| **pass** | the implementation satisfies the criterion |
| **fail** | it offers the capability and behaves wrongly |
| **missing** | it does not offer the capability at all — a **divergence** |
| **skip** | not testable in this harness, with the reason stated |

`missing` is the distinction that carries the value. Folding it into `fail` reports a
package that never implemented something as merely buggy; folding it into `skip` hides
it. §13's divergence list is precisely the set of `missing` outcomes.

## The registry cannot drift

`src/criteria.ts` is **generated** from the spec by `scripts/sync-criteria.mjs`, and
`tests/coverage.test.ts` fails if the checked-in copy differs from what the spec would
produce today. Every criterion must have a check or an explicit skip reason, and every
skip must state one — a criterion with no outcome is how a suite quietly stops testing.

## Measured, 2026-08-23 — after the httpeers-stack line landed

**`adapters/reference.ts`** — 31 pass, 0 fail, 0 missing, 54 skip.

**`@statewalker/httpeers.core`** — **16 pass, 3 fail, 7 missing, 59 skip.**

Two days earlier the same package measured 4 / 3 / 24 / 54. The httpeers-stack line
reconciled it to ADR-0019 — Biscuit tokens, the access tree and vocabulary rebuilt as
Datalog rules, and `audience` with destination enforcement — which closed **twelve**
criteria. D-12, D-14, D-15 and D-16 of §13 are done.

What is left, and what it means:

- **R-05…R-07 FAIL** — the only genuine behavioural gap (**D-09**). `provide()`
  normalises a trailing slash and accepts a duplicate prefix where ADR-0006 requires a
  throw naming every conflict.
- **X-05…X-07, X-09 missing** — the intermediary transform (**D-11**) has no
  equivalent. This is the one that keeps a caller's mesh token out of an upstream
  service's logs.
- **A-13, A-13b, A-23 missing** — delegation. This is the **specified** state, not a
  defect: ADR-0010 reserves the actor claim and defers enforcement to the reverse
  proxy, so core correctly offers no `attenuate` and no delegation scope.

Five criteria moved from `missing` to `skip` because the adapter now distinguishes two
different claims: "core lacks this behaviour" from "this harness cannot construct the
input through core's public API". A token carrying an extra constraint (A-20), an
injected evaluation budget (A-25) and a literal revocation list (A-18, A-21) are the
latter — core does these, just not through a seam a test can reach.

> **The adapter is part of the measurement.** Its first version declared no `tokens`
> capability, because core was JWT-shaped when it was written. Re-run unchanged against
> the reconciled core, it still reported 24 missing — scoring the adapter's staleness
> as the implementation's gap. An adapter that is not maintained alongside the thing it
> measures reports a number that looks precise and is wrong.

## A finding, from the first run

Criterion **A-04** — *"facts the node asserts are never taken from the token"* — failed
against the reference implementation.

Biscuit puts authority-block facts and authorizer facts in one set, so a token
carrying `connection_peer("alice")` satisfies its own
`check if bound($k), connection_peer($k)`. The binding rule, which is the load-bearing
rule of the entire trust model, verified against a fact the **token** supplied.

Appended blocks cannot reach this — Biscuit scopes their facts, confirmed separately —
so it is not member-exploitable. It is an unstated **invariant**: an authority block
must never declare a predicate the verifier owns. `adapters/reference.ts` now rejects
any token declaring one, which makes the invariant checked instead of assumed. The
spec already required this; the implementation simply did not enforce it.

## Adding an implementation

Implement `Implementation` from `src/types.ts`. Every capability is optional, and an
absent one reports `missing` for the criteria that need it — which is the point. Do
**not** emulate a missing capability inside an adapter: the suite would then be testing
the adapter's emulation rather than the implementation.

```ts
import { describeConformance } from "@statewalker/httpeers-conformance";
describeConformance(myImplementation);
```

## What this does not cover

- **No transport, hub or edge.** 54 of 85 criteria need one; the prototypes in
  `apps/httpeers-protos` establish the transport properties over real libp2p nodes.
- **No directory, rotation or pinning** (A-16, A-17, A-22). ADR-0008's resolution seam
  and ADR-0018's signed succession chain are unexercised.
- **The forwarding router** (R-08…R-12). The harness models mount tables, not a
  router with an observable dial counter, so the open-relay criteria are skipped —
  prototype 06 covers them over real nodes.
- **No performance claim.** Nothing here is a benchmark.
