# @statewalker/httpeers-conformance

> **Experimental / internal.** Private package in `statewalker-sandbox`. Not published to npm.

## What it is

One test per numbered criterion of the httpeers block API, and a measurement of any
implementation against it. Each criterion ends in one of four outcomes:

| | meaning |
|---|---|
| **pass** | the implementation satisfies the criterion |
| **fail** | it offers the capability and behaves wrongly |
| **missing** | it does not offer the capability at all: a **divergence** |
| **skip** | not testable in this harness, with the reason stated |

## Why it exists

A specification lists divergences in prose, and prose does not say which of them matter or when
one is closed. This suite turns the list into outcomes, so a large package can be reconciled
against a red/green signal rather than against a document.

It also keeps the specification honest in the other direction: a suite nothing passes cannot be
told apart from a suite whose checks are wrong, so `adapters/reference.ts` implements the specified
behaviour and must stay green.

### Why `missing` is its own outcome

Folding `missing` into `fail` reports a package that never implemented something as merely buggy;
folding it into `skip` hides it. The set of `missing` outcomes is the divergence list.

## How to use

The suite reads the specification `docs/superpowers/specs/2026-08-20-httpeers-api-design.md`,
which is not in this repository: `scripts/sync-criteria.mjs` looks for it in the directories above
this package, or at the path in `HTTPEERS_SPEC`.

```bash
pnpm --filter @statewalker/httpeers-conformance test           # the suite's own health: reference adapter + integrity
pnpm --filter @statewalker/httpeers-conformance report:gap     # an implementation measured against the spec
pnpm --filter @statewalker/httpeers-conformance sync-criteria  # regenerate src/criteria.ts after the spec changes
```

`test` and `report:gap` are separate on purpose. The gap is a measurement, not a regression, and a
permanently red `test` is one that gets disabled.

Entry points: `.` (`src/index.ts`: `describeConformance`, `ledgerFor`, `CRITERIA`, `BLOCKS`,
`CHECKS`, `RULES`, and the types in `src/types.ts`) and `./*` (any module under `src/`).

## Examples

Measure an implementation: implement `Implementation` from `src/types.ts` and hand it to the suite.

```ts
import { describeConformance } from "@statewalker/httpeers-conformance";

describeConformance(myImplementation);
```

Every capability on `Implementation` is optional; an absent one reports `missing` for the criteria
that need it. Do **not** emulate a missing capability inside an adapter: the suite would then test
the adapter's emulation rather than the implementation. `adapters/httpeers-core.ts` is the adapter
for `@statewalker/httpeers.core`.

## Internals

### Why the registry cannot drift

`src/criteria.ts` is **generated** from the specification by `scripts/sync-criteria.mjs`, and
`tests/coverage.test.ts` fails if the checked-in copy differs from what the specification produces.
Every criterion must have a check or an explicit skip reason, and every skip must state one: a
criterion with no outcome is how a suite quietly stops testing.

### The adapter is part of the measurement

An adapter that declares fewer capabilities than its implementation has scores its own staleness
as the implementation's gap. Keep `adapters/httpeers-core.ts` in step with `httpeers.core`.

### An invariant the reference adapter enforces

Biscuit puts authority-block facts and authorizer facts in one set, so a token carrying
`connection_peer("alice")` would satisfy its own `check if bound($k), connection_peer($k)`.
Appended blocks cannot do this (Biscuit scopes their facts), so it is not exploitable by a member,
but it makes an invariant: an authority block must never declare a predicate the verifier owns.
`adapters/reference.ts` rejects any token that declares one.

### What breaks

- **Without the specification file**, `tests/coverage.test.ts` and `tests/parse-ids.test.ts` fail
  at load: `sync-criteria: could not find docs/superpowers/specs/2026-08-20-httpeers-api-design.md above ... Set HTTPEERS_SPEC to point at it.`
  (`scripts/sync-criteria.mjs` throws on import). CI excludes both files.
- **Not covered:** transports, hubs and edges (most criteria need one; `apps/httpeers-protos`
  shows the transport properties over real libp2p nodes); directory, key rotation and pinning; the
  forwarding router (the harness models mount tables, not a router with an observable dial count);
  performance.

### Dependencies

`@statewalker/httpeers.core` (the measured implementation), `@statewalker/webrun-biscuit` (tokens
for the reference adapter), `@libp2p/interface` and `@libp2p/peer-id` (peer ids).

## License

MIT
