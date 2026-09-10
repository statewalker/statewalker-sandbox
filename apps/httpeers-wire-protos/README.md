# httpeers-wire-protos

> ## ⚠ This is a historical rung, not a candidate implementation.
>
> **The code in `src/wire.ts` and `src/transport-wire.ts` is retired, and it was retired by
> the session that wrote it.** Note 28 of the same Drive folder ("T-1 DECIDED: Adopt the
> Shared Stack") opens: *"**Decision: adopt.** `transport-wire.ts` + `wire.ts` are deleted.
> The mesh now runs on `webrun-http-streams` over a libp2p 3.x adapter of our own."* That
> adapter became **`packages/httpeers.core/src/transport-duplex.ts`**, which is the transport
> this repo actually ships — same `/httpeers/1.0.0` protocol id, same 512-stream cap, and
> ~630 lines of contract this rung does not have.
>
> **Do not import anything from this app. Do not copy `wire.ts` into a package. If you are
> looking for the httpeers transport, it is `packages/httpeers.core/src/transport-duplex.ts`.**
>
> What is kept here is **evidence, not code**: 18 recovered tests that passed against a real
> transport, and what a mutation pass over them revealed. Thirteen of those 18 are also the
> acceptance suite for `transport-duplex.ts` (folder 29 carried them forward "changed by one
> import line only") and `httpeers.core` does not have them — see
> [How this relates to `transport-duplex.ts`](#how-this-relates-to-packageshttpeerscoresrctransport-duplexts),
> which is the one part of this README with a live consequence.
>
> The work order that produced this app (MESH-1) stops one generation short of note 28 and
> does not know any of the above. `PROVENANCE.md` and
> [What §4 of the work order gets wrong](#what-4-of-the-work-order-gets-wrong) record that.

---

With that said, what the rung *was*: HTTP over a raw libp2p protocol, with `@libp2p/http`
removed entirely.

One rung, one question: *can a transport of our own carry ordinary HTTP semantics over
libp2p without the two defects that made `@libp2p/http` unusable?* The wire format is one
line —

```
<JSON.stringify(envelope)>\n<body bytes...>
```

— and the claim is that it has fewer places to be wrong than HTTP/1.1 request-line parsing,
not more. `JSON.stringify` never emits a literal `\n`, so the first `0x0a` ends the
envelope; end-of-stream is end-of-body; there is no `content-length` and no chunk framing.
Half-close (`stream.close()` shuts the write side only) is what lets the client send a
streamed body and then read the reply off the same stream.

Companions in this repo: [`httpeers-protos`](../httpeers-protos) is the mesh ladder as
runnable demos, [`httpeers-shell-protos`](../httpeers-shell-protos) the shell ladder as a
test suite. This one is a test suite too.

## Running it

```bash
pnpm test           # all 30, real libp2p nodes over loopback TCP and a circuit relay
pnpm test:watch
pnpm typecheck
```

Every suite starts real libp2p 3.3.8 nodes and performs a real Noise handshake — no mocks
at the network layer. `--no-file-parallelism` is not optional: three of the four files bind
loopback ports and push megabytes through them. Four tests in `gaps.test.ts` drive `wire.ts`
through a `Stream` double instead, because the interleavings they assert cannot be produced
by a real transport; each says so in place.

| File | Tests | What it answers |
|---|---|---|
| `src/wire.test.ts` | 5 | Q1 query string survives · Q2 request body streams *incrementally* · Q3 response body streams · Q4 the proven peer id is still reachable · Q5 4 MB passes |
| `src/relay.test.ts` | 3 | R0 a relayed connection stands up · R1 half-close propagates through circuit-relay · R2 8 MB under backpressure |
| `src/robustness.test.ts` | 10 | B1 bodiless statuses incl. 205 · B2 HEAD · B3 zero-length body · B4 a throwing handler rejects rather than hangs · B5 40 concurrent streams · B6–B8 non-ASCII url and latin1 headers |
| `src/gaps.test.ts` | 12 | every gap the mutation pass found in the three above |
| **total** | **30** | |

`PROVENANCE.md` is the index: which files are recovered byte-for-byte (with sha256s), the
single documented delta, what was deliberately not adopted, and the full mutation table.

## Findings about `packages/httpeers.core`, filed and reproducible

The M6b result below — that a node dialling without registering the protocol is capped at
libp2p's default 64 outbound streams — prompted a check of whether the same blind spot is in
the shipped descendant. **It is not**: `createRemote` passes `maxOutboundStreams` as a
per-dial option into `node.dialProtocol` via `connect()`, rather than relying on a
`node.handle` registration, and `concurrency.test.ts` already covers a dial-only client that
never calls `serveTransport`. That question is closed.

The check turned up three other things, all about `packages/httpeers.core`, **none of which
was modified here**:

| | |
|---|---|
| **umbrella #28** | A wide burst of concurrent calls on a connection where **no request has yet completed** fails wholesale — **0 of 100, in 5 runs out of 5**; one completed request on that connection first and the same burst is **100 of 100, 5 out of 5**. Includes the config hazard: `DEFAULT_MAX_CONCURRENT_OUTBOUND === DEFAULT_MAX_STREAMS` by definition and nothing enforces that they move together, so **lower one and the semaphore stops protecting anything** — the cliff it exists to remove is back. |
| **umbrella #29** | `UnexpectedEOFError` reaches `kind: "unknown"` through `mapPeerCallError`, whose stated contract is "a `PeerCallError`, never a raw transport exception". `errors.ts` already has a narrowed branch for the adjacent `HttpParseError` condition. Filed separately from #28 on purpose: fixing the taxonomy does not fix the burst. |

```bash
pnpm install --filter @statewalker/httpeers.core...
pnpm --filter @statewalker/httpeers.core exec tsx \
  ../../apps/httpeers-wire-protos/tools/repro-cold-burst.mts
```

`tools/repro-cold-burst.mts` is the #28 reproduction. It is **not a test** and is in no suite:
it runs against the shipped `transport-duplex.ts`, prints the four probes, and exits 0 only if
the failure reproduces — so a later clean run registers as a change rather than a quiet pass.
Its header carries the exact versions, why the suite does not catch it (nothing in those 11
test files fires more than 9 concurrent calls), and both other observations.

**The mechanism is not established and the repro does not guess at one.** Three things hold
across all five runs — the first cold burst fails, the second cold burst fails, a warm burst
passes — and one thing explicitly does not: a cold burst that follows a *successful* burst in
the same process is **variable** (0/100 in 2 runs, 100/100 in 3; roughly even over ten). So the
precondition is not purely per-connection and something process-wide participates. What that is
has not been determined, and no cause is offered.

The script's exit status gates on the deterministic three **only**. Gating on the variable
fourth would have produced a reproduction that "fails" about half the time for a reason that is
not the bug — the row is printed every run and never asserted. That correction came from
running it: the first version gated on all three cold bursts and exited 1 on its second run.

## Re-running the mutation pass

```bash
node tools/mutate.mjs              # all 27 mutants
ONLY="M4a,M6b" node tools/mutate.mjs
```

`tools/mutate.mjs` is the §5.3 harness: it applies one mutation at a time by exact string
replacement, runs the suite, records KILLED / SURVIVED, and restores the file — including on
`process.exit`, so an interrupted run leaves no mutated tree. **Copy it for the next unit
rather than writing a new one, and keep its two guards.** It runs an **unmutated control
first** and refuses to proceed unless that is green with a parsable tally, and it reports any
run whose tally line did not parse as **HARNESS-ERROR rather than KILLED**.

Both guards exist because the first version of this harness reported 27 mutants out of 27
killed and the suite looked perfect. The cause was `--reporter=basic`, which does not exist
in Vitest 4: every run died loading the reporter, exited non-zero, and scored as a kill.
§5.4's "treat a first-run pass as suspicious rather than reassuring" is what caught it, on
the first clean sweep. A harness that cannot distinguish "the suite failed" from "the suite
never ran" will tell you your tests are perfect, which is the one answer a mutation pass
should never be able to give.

One operational note: a mutant that *hangs* rather than failing is killed by test timeout,
but several hanging files together can exceed the per-run budget and land as HARNESS-ERROR.
M7 (half-close removed) does exactly that — re-run it alone with `ONLY=` before concluding
anything about it. It is a kill: 4 failures, all by timeout.

## Where this came from

The 17 August 2026 session recorded in `notes/drive/2026-08-16.Httpeers-Plan/`. The three
test files and two of the three source files come out of folder
`16-httpeers-prototype-v2 (envelope transport)` byte-identically; `types.ts` and
`peer-context.ts` come from folder 12, which folder 16's README lists as "byte-identical,
not duplicated here".

**This is v2 because v1 failed twice, silently.** Note 13: query parameters dropped from the
request line. Note 14: streamed request bodies arriving empty. Both were invisible — the
request appeared to succeed and quietly lost data — and note 15 resolved both by replacing
`libp2p-http` rather than patching it. The mutation pass re-established that this suite
would in fact catch both: see PROVENANCE.md, M1 and M2/M2b.

## How this relates to `packages/httpeers.core/src/transport-duplex.ts`

**It is superseded by it, by an explicit decision in the same Drive session** — and the
supersession is not a judgement call, it is recorded. Note 28 ("T-1 DECIDED: Adopt the
Shared Stack") opens:

> **Decision: adopt.** `transport-wire.ts` + `wire.ts` are deleted. The mesh now runs on
> `webrun-http-streams` over a libp2p 3.x adapter of our own.

Folder 29 is the result — v0.5.0, 54/54 — and it deletes `transport-wire.ts`, `wire.ts` and
`wire.test.ts`, replacing 213 lines with a 65-line `transport-duplex.ts`. That file is the
direct ancestor of `packages/httpeers.core/src/transport-duplex.ts`, which has since grown
to ~630 lines by adding a request-timeout contract, an error taxonomy, and an outbound
admission semaphore.

So, precisely:

- **It duplicates what `transport-duplex.ts` does.** Same protocol id `/httpeers/1.0.0`,
  same `DEFAULT_MAX_STREAMS = 512` for the same reason (note 18's concurrency cliff), same
  `registerPeer`-before-dispatch identity discipline, same null-body status set
  `{101, 103, 204, 205, 304}`. `transport-duplex.ts`'s header even names the same constraint
  this rung's `peer.ts` embodies — one file imports libp2p.
- **It does not complement it.** Nothing here is reachable from `httpeers.core`, and nothing
  here is missing from it. `wire.ts`'s envelope is the same format, hand-rolled:
  `webrun-http-streams` is where it already lived (`wire.ts`'s own header says "borrowed
  from" it), which is exactly why the migration was a net −148 lines.
- **The supersession cost nothing and proved something.** Note 28 ran both transports side
  by side before deleting either — 72/72 — so parity was demonstrated, not assumed.

**What this app is therefore for:** it is the rung, not the design. Its value is the
evidence, and there are two pieces of it worth keeping.

First, the *migration* found a real upstream defect, and this rung is why it was
recognised. Note 28 §3: `webrun-http-streams`'s Duplex path (`fetch.ts`) had **no
null-body status handling**, so the 304 test threw `Invalid response status code 304` —
"the newer, recommended path regressed against the older one it deprecates". It was fixed
by a three-line vendored patch whose content is `NULL_BODY_STATUS` plus the two guards
`transport-wire.ts` already had. Note 28 calls the independent rediscovery in two codebases
"a reasonable signal that the set belongs in one shared place". It is still a vendored
patch, not an upstream release, as far as this unit could establish.

Second — and this is the actionable part — **13 of these 18 tests are the acceptance suite
for `transport-duplex.ts` too, and `httpeers.core` does not have them.** Folder 29's README
is explicit that `relay.test.ts` and `robustness.test.ts` were carried forward "changed by
one import line only", swapping `./transport-wire.js` for `./transport-duplex.js`. Only
`wire.test.ts` died with the format it tested. Meanwhile `packages/httpeers.core/tests/`
has 176 tests across 11 files and **no test mentions 205, a bodiless status, HEAD, or a
circuit relay at all** — its own `errors.ts` says `PeerRelayLimitExceededError` is
"grounded, but unwired and untested in this stack — this package has no relay transport".
So the 13 tests cover precisely the two areas `httpeers.core` currently does not, including
the exact regression note 28 had to patch by hand. Porting them is a one-import change with
a recorded precedent. That is a recommendation, not part of this unit: MESH-1 was scoped to
land a prototype app, and promoting anything into `httpeers.core` is not in it.

## A conflict in the work order

MESH-1 says the v1 prototype at item 12 "is history; do not consult it as a source". Folder
16's own README says `types.ts` and `peer-context.ts` are "unchanged from folder 12 —
byte-identical, not duplicated here". Both cannot be honoured: `transport-wire.ts` imports
`registerPeer` from `peer-context.js` and `FetchHandler`/`PeerIdStr` from `types.js`, and
`wire.test.ts` imports `lookupPeer` from `peer-context.js` directly. Without those two
files not one of the three adopted tests can even be collected.

Resolved in favour of the suite, which §0.3 makes the specification: the two files are
copied from folder 12 byte-identically, and nothing else is. `peer.ts` is *not* adopted —
it would have pulled in five more folder-12 files whose own tests were never exported, which
§0.2 forbids. PROVENANCE.md records both decisions.

## What §4 of the work order gets wrong

Checked while executing it. Each of these is verifiable from the mirror or from this repo.

1. **"Transport v2" is nine rungs behind the session that produced it.** §4 presents folder
   16 as the transport to adopt; the same Drive folder contains
   `29-httpeers-prototype-v3 (shared stack, validated)`, then v0.6.0 (router hardened),
   v0.7.0 (access tree), v0.8.0 (revocation), v0.9.0 (role vocabulary) and E1 (edge join) at
   items 31, 33, 35, 37 and 40. §4 mentions none of them, and the very first of them deletes
   the code §4 asks for. MESH-1 is still executable and its suite is still real evidence —
   but it lands a transport its own session retired, which should be a deliberate choice
   rather than a surprise.
2. **The mesh already has `packages/`, and the transport already has a home.** §4 opens "no
   `packages/`, and zero test files. The transport work below has no home yet; creating one
   is MESH-0", and §8.3 asks whether to add `packages/httpeers-wire`. In *this* repo
   `packages/httpeers.core` exists, carries `transport-duplex.ts`, `peer.ts`, `router.ts`,
   `store.ts`, `tokens.ts`, `peer-context.ts`, `types.ts` and more, and has 176 tests in
   `tests/`. `packages/httpeers-conformance` exists too, and `apps/httpeers-stack` is an
   installable deployment on top of them. MESH-0 is moot and §8.3 has been answered. (§4's
   sentence is about the separate `httpeers` repo, which this unit did not inspect; the team
   lead reports `apps/relay` there has four test files, not zero. Either way the conclusion
   drawn from it — that the transport has nowhere to go — does not hold.)
3. **"Nothing is corrupt" is true, but "take the former" needs its reason stated.** §4 says
   to take `transport-wire.ts` (3525 B) over `transport-wire.superseded.ts` (2380 B) and
   calls the latter "locally-added bookkeeping". It is more than that: the superseded copy
   special-cases only 204/304 and leaves `maxInboundStreams` at libp2p's default 32, so it
   *fails* B1/205 and B5. Taking the wrong one is caught by the suite within seconds, which
   is reassuring, but the files are not interchangeable bookkeeping variants.
4. **§4 does not mention that folder 16 cannot stand alone.** See "A conflict in the work
   order" above. A reader following §4 literally gets three uncollectable test files.

Two smaller record errors, in the mirror rather than the work order: `STATUS.md` says
"`package.json` in this folder is **v0.4.0**, pinned to versions the suite has actually run
against", and there is no v0.4.0 manifest in the folder — the two present are `package.json`
(v0.2.0, declaring the `libp2p ^2.0.0` mixed tree that same paragraph exists to warn about)
and `package.json (v0.3.0 - verified versions).json`, which is the file being described and
the one pinned here. And folder 16's `README.md` omits `relay.test.ts` and
`robustness.test.ts` from its contents table, because it was written before they existed.
PROVENANCE.md has the detail.

## Versions

Pinned from `package.json (v0.3.0 - verified versions).json`, whose own `_note` explains
why exact pins matter here: an earlier hand-written manifest declared `libp2p ^2.0.0`
against a 3.x tree and **passed 46 tests on that mixed tree** before circuit-relay exposed
the mismatch (note 17 §3).

**No conflict with this workspace's catalog.** Every libp2p-side pin the v0.3.0 manifest
names is already in `pnpm-lock.yaml` at exactly that version, because
`apps/httpeers-stack` and `packages/httpeers.core` independently converged on the same set
— `libp2p 3.3.8`, `@chainsafe/libp2p-noise 17.0.0`, `@chainsafe/libp2p-yamux 8.0.1`,
`@libp2p/circuit-relay-v2 4.2.11`, `@libp2p/crypto 5.1.22`, `@libp2p/identify 4.1.12`,
`@libp2p/peer-id 6.0.14`, `@libp2p/tcp 11.0.26`, `@multiformats/multiaddr 13.0.3`. This app
states them as exact versions rather than the manifest's carets, matching the two packages
above rather than drifting from them.

`vitest`, `typescript` and `@types/node` use `catalog:` — the manifest asked for
`vitest ^4.0.0` and the catalog's `^4.1.4` satisfies it. `hono ^4.13.2` is in the manifest
but not needed: it is `endpoints.ts`'s dependency, and `endpoints.ts` is not adopted. The
catalog's `hono ^4.12.14` would have been the only numeric disagreement in the set, and it
does not arise.

The one thing the catalog did surface is in PROVENANCE.md → "The one adoption delta": the
prototype had no typecheck step, and under the catalog's TypeScript 6.0.3 `wire.ts` needs
one type annotation.
