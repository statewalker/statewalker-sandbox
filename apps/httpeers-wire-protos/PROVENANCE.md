# Provenance

What in this app is **recovered code**, what is a **reconstruction**, and what is neither —
adopted 2026-09-09 from the Drive folder
`notes/drive/2026-08-16.Httpeers-Plan/16-httpeers-prototype-v2 (envelope transport)/`,
per work-unit MESH-1 of `notes/2026/2026-09/2026-09-09/[umbrella-next].prototype-adoption.md`.

The distinction is never blurred. Recovered code is evidence of what the 17 August session
did; anything else is evidence only of what this adoption decided. Every file below says
which it is, and each recovered file is pinned by the sha256 of the mirror byte stream it
was copied from, so the claim is checkable rather than asserted.

Unlike the shell ladder, **nothing here was corrupt.** The v2 prototype was exported as
plain `.ts` files, not an archive, so the question this app answers is not "can it be
recovered" but "does the recovered code satisfy the suite that came with it". It does.

## Per file

| File | Status | Source | sha256 of the mirror copy |
|---|---|---|---|
| `src/wire.test.ts` | **recovered**, byte-identical, assertions unmodified | folder 16 | `8a841ebb38d1c84ab1ddd4389bb15ffdf2b79850923c2dc1590656a6f39bd9df` |
| `src/relay.test.ts` | **recovered**, byte-identical, assertions unmodified | folder 16 | `7e6b4410ee22aee27de16e62d3883c634b3cb429c6106b9cc27705274d968fcc` |
| `src/robustness.test.ts` | **recovered**, byte-identical, assertions unmodified | folder 16 | `8f0b9ccff694468dec098b87f7375fd76853dc9b11aefe33b920005313a00288` |
| `src/transport-wire.ts` | **recovered**, byte-identical | folder 16 | `bab06df75a097e2b7d9baaf568f7b3f245fd0c450d1b8d2256ab169776494b8b` |
| `src/wire.ts` | **recovered**, one documented delta | folder 16 | `ddc4f06ddbed6c38409cad91564257976f2a09c81da636dce331817222357c0c` |
| `src/types.ts` | **recovered**, byte-identical | folder 12 | `af81bf72b1e7b84611bdfb8c8a9f35e156db0ae05cd6c03f8d2fc70af4b8b266` |
| `src/peer-context.ts` | **recovered**, byte-identical | folder 12 | `bcbebf7856280f5fc528ee45a4352c65d2b304a772519d3190b6cd8b50e3ca88` |
| `src/gaps.test.ts` | **written here.** Not recovered, not a reconstruction of anything | the mutation pass below | — |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, this file, `README.md` | written here | — | — |

The seven recovered files are excluded from the formatter and linter in the root
`biome.json`. Their whole evidential value is that they are byte-identical to the export;
`pnpm lint` would otherwise rewrite them to house style and the sha256 column above would
stop meaning anything. `gaps.test.ts` is deliberately *not* excluded — it follows house
style, which keeps the boundary visible at a glance.

## Test counts per source file

| File | Tests | Network |
|---|---|---|
| `src/wire.test.ts` | 5 (Q1–Q5) | real libp2p over loopback TCP |
| `src/relay.test.ts` | 3 (R0–R2) | real libp2p over a circuit relay |
| `src/robustness.test.ts` | 10 (B1×3, B2–B8) | real libp2p over loopback TCP |
| **adopted subtotal** | **18** | |
| `src/gaps.test.ts` | 12 (G1–G9, G3b, G3c, G3d) | 8 over real libp2p, 4 through a `Stream` double |
| **total** | **30** | |

`pnpm test` reports **30 passed (30)**, 4 files, **none skipped**, and `pnpm typecheck` is
clean. The 18 adopted tests are all present, unmodified, and none is skipped — that is the
MESH-1 done condition, and the remaining 12 exist only because the mutation pass §5.3
requires found them missing.

18 matches the count `STATUS.md` gives for these three files (5 + 3 + 10). It does **not**
match that file's headline "59/59": 41 of those 59 are in files folder 16 did not export
(`integration.test.ts` 18, `binding.test.ts` 7, `router.test.ts` 6, `tokens.test.ts` 5,
`store.test.ts` 5), which is why the README calls them "unchanged from folder 12, not
duplicated here".

## The one adoption delta

`src/wire.ts` line 71. Nothing else in any recovered file was touched.

```diff
-  let tail = new Uint8Array(0)
+  let tail: Uint8Array = new Uint8Array(0)
```

TypeScript 6.0.3 (this workspace's catalog pin) infers `Uint8Array<ArrayBuffer>` from
`new Uint8Array(0)`, while `asBytes` returns `Uint8Array<ArrayBufferLike>`, so the
`tail = chunk.subarray(nl + 1)` eight lines down does not typecheck. Type-level only; the
emitted JavaScript is unchanged and the suite's behaviour is identical either way. **The
prototype had no typecheck step at all** — its `package.json` declares no `typescript` and
its only script is `vitest run` — so this had never been seen before.

## What was deliberately NOT adopted

**`src/transport-wire.superseded.ts` (2380 B).** The mirror had to disambiguate two
same-titled Drive siblings; `transport-wire.ts` (3525 B) is the live one and is what is
here. The superseded copy is not bookkeeping that happens to be redundant — it is *wrong*:
it special-cases only 204/304 (so robustness B1's 205 case throws) and leaves
`maxInboundStreams` at libp2p's default of 32 (so B5's 40 concurrent requests reset). Both
failures are exactly what note 18 recorded. It is not in this app in any form.

**`src/peer.ts`.** The work order's §0.2 — no source file is copied into a package that has
no failing test demanding it — excludes it. No test in the v2 export reaches `createPeer`,
and `peer.ts` imports seven further modules (`endpoints`, `router`, `store`, `tokens`,
`peer-handlers`, plus `types` and `peer-context`) of which five arrive with no suite at
all: their tests live in folder 12's `integration.test.ts`, `router.test.ts`,
`tokens.test.ts` and `store.test.ts`, which folder 16 did not export. Copying `peer.ts`
would have imported five unverified files to satisfy an import graph, not a test. `types.ts`
and `peer-context.ts` *are* here because `transport-wire.ts` imports both and
`wire.test.ts` imports `lookupPeer` directly — they are demanded by a failing test.

**Nothing from folder 12 beyond those two files.** The work order says the v1 prototype at
item 12 is history and must not be consulted as a source; folder 16's own README says
`types.ts` and `peer-context.ts` are "byte-identical, not duplicated here". Those two
statements conflict, and the suite settles it: without those two files the three adopted
tests cannot even be collected. See README.md → "A conflict in the work order".

## Proving the suite — the mutation pass (§5.3)

27 mutations, applied one at a time to a pristine tree, suite run, tree restored.
**25 killed, 2 surviving, both equivalent mutants.** The first pass (against the 18 adopted
tests alone) killed 17 and left 10 standing; `gaps.test.ts` was written to close 8 of those
10, and the remaining 2 are argued below rather than waved at.

A note on method, because it nearly went wrong: the **first** run of the harness reported
27/27 killed, which §5.4 says to distrust rather than celebrate. It was distrusted, and the
cause was the harness, not the suite — `--reporter=basic` does not exist in Vitest 4, so
every run died loading the reporter and every mutant looked dead. The harness now runs an
unmutated control first and refuses any result whose tally line did not parse.

### Mutants killed by the adopted suites alone (17)

| # | Mutation | Killed by |
|---|---|---|
| M1 | envelope carries origin+pathname, dropping the query | Q1, B5, B6 |
| M2 | request body never written to the stream | 10 tests |
| M2b | request body buffered and flushed at the end instead of streamed | Q2, Q3 |
| M3b | envelope reassembly skips the final part | 15 tests |
| M4c | client-side null-body check loses its status arm | B1 ×3 |
| M4d | 205 removed from `NULL_BODY_STATUS` | B1/205 |
| M5a | request headers dropped from the envelope | B8 |
| M5b | response headers dropped from the envelope | B2 |
| M5c | request method forced to GET | 5 tests |
| M5e | response status forced to 200 | B1 ×3 |
| M6a | `maxInboundStreams` reverted to libp2p's default 32 | B5 |
| M7 | `stream.close()` removed — no half-close | 4 tests, by timeout |
| M9 | proven peer id replaced by a constant | Q4 |
| M10 | GET/HEAD body suppression removed in `fromEnvelope` | 10 tests |
| M11 | handler error swallowed instead of aborting the stream | B4 |
| M12 | `runOnLimitedConnection` false on the serving side | R1, R2 |
| M13 | `runOnLimitedConnection` false on the dialing side | R1, R2 |

**Both v1 show-stoppers are caught, and the suite is not merely lucky about it.** M1 is
note 13's dropped query parameter: three tests fail, Q1 by name. M2 is note 14's empty
streamed request body: ten tests fail. M2b is the sharper version of the same question —
all the bytes arrive, just not incrementally — and Q2 kills it, because Q2 compares arrival
timestamps on the server against send timestamps on the client rather than only counting
bytes. A transport that silently reverted to buffering would be caught.

### Survivors of the first pass, and what each one meant (10)

| # | Mutation | Verdict |
|---|---|---|
| M3 | `parts.push(chunk)` removed, so an envelope spanning more than one wire chunk loses everything before the delimiter | **uncovered.** Every envelope in the adopted suites fits one chunk, so the accumulation loop only ever ran one iteration. Closed by **G1** (512 KB of url + 512 KB of header). |
| M3d | the `tail` arm removed, so body bytes that arrived inside the envelope's own chunk are dropped | **uncovered.** libp2p happens to deliver `writeMessage`'s envelope `send()` and its body `send()`s as separate chunks, so the arm is unreachable over a real connection — but nothing in the wire format promises that framing. Closed by **G2**, through a `Stream` double. |
| M4a | the **serving** side's `sendBody` guard removed | **uncovered, and masked.** Every adopted handler already returns `new Response(null, …)` for a bodiless status, and the `/head` handler branches on the method itself, so the transport's own guard never had to work. Worse, the *client's* HEAD arm discards whatever arrives, so `remote()` cannot see the difference at all. Closed by **G3c**, which reads the raw protocol stream and asserts no body bytes were put on the wire. G3, which only checks `res.text()`, does **not** kill it — recorded here because that is exactly the symmetric-pair trap §5.3 names. |
| M4b | the **client** side's HEAD arm removed | **weak test.** B2 asserts `await res.text() === ''`, which an empty `ReadableStream` satisfies just as well as a null body. Closed by **G4**, asserting `res.body === null`. |
| M5d | `statusText` dropped from the response envelope | **uncovered.** No adopted test looks at the reason phrase. Closed by **G5**. |
| M6b | `maxOutboundStreams` reduced to 1 | **uncovered, and the finding is larger than the mutation.** See below. |
| M8 | `if (!stream.send(bytes)) await stream.onDrain()` reduced to `stream.send(bytes)` | **weak test.** R2's own comment calls itself "exercising backpressure", but it asserts only that 8 MB and more than one chunk arrived — which a transport that ignores `send()`'s return value and buffers without bound also satisfies. Closed by **G6**, which holds `onDrain` open and asserts the writer stops. This is the same hazard `apps/httpeers-protos/04-backpressure` records for libp2p 3.x, so it is a known way to be wrong, not a hypothetical. |
| M15 | zero-length body chunks forwarded instead of skipped | **uncovered.** Closed by **G8**, counting frames through a `Stream` double. |
| M3c | `next.done === true` widened to `next.done === true \|\| next.value == null` | **equivalent mutant.** Divergence needs a `{ done: false, value: null }` result, which the async-iterator protocol does not produce and libp2p's stream iterator never emits. If one ever did, the *original* throws inside `asBytes` while the mutant closes cleanly — so the mutant is never less correct. Not a gap. |
| M14 | `if (chunk.byteLength === 0) continue` removed from the envelope scan | **equivalent mutant.** An empty chunk falls through to `indexOf(NEWLINE) === -1`, is pushed as a zero-length part, and contributes 0 to both `total` and the `head.set` reassembly. Provably identical output for every input. **G9** pins the tolerance as a contract but does not kill it, and says so in place. |

### The M6b finding, stated separately because it is not just a surviving mutation

Measured on libp2p 3.3.8 while closing it: a node that **dials** `/httpeers/1.0.0` without
having **registered** it is capped at libp2p's own default of **64** concurrent outbound
streams — the 65th rejects with `TooManyOutboundProtocolStreamsError`. A node that has
called `serveWire` reaches 400 without complaint, because `node.handle`'s
`maxOutboundStreams: DEFAULT_MAX_STREAMS` is where libp2p reads that number from.

Every client in all three adopted suites calls `wireRemote` **without** `serveWire`.
So B5's 40 concurrent requests sat under libp2p's default 64 and never touched
`DEFAULT_MAX_STREAMS`'s outbound half at all. B5 proves the **inbound** cap — reverting it
to 32 does fail B5 (M6a) — and nothing more. `peer.ts` calls both `serveWire` and
`wireRemote`, so the shape a real peer has is the one **G7** builds: a serving peer issuing
100 concurrent outbound calls, which passes only because its own registration raised the
cap.

One test-hygiene note found on the way: the **first** concurrent burst in a fresh Node
process fails wholesale regardless of any cap, and succeeds on every subsequent attempt.
G7 therefore makes one warm call before the burst. B5 gets the same warm-up for free from
the tests that run ahead of it in its own file — which means B5's own robustness depends on
its position in the file, undeclared.

## Corrections to the record

Found by adopting it. In every case the code is right and the prose is not.

- **`STATUS.md` mis-describes its own folder's `package.json`.** It says "`package.json` in
  this folder is **v0.4.0**, pinned to versions the suite has actually run against". There
  is no v0.4.0 manifest in the folder: the two files present are `package.json` (v0.2.0,
  declaring `libp2p ^2.0.0` — the mixed tree note 17 §3 says passed 46 tests before
  circuit-relay exposed it) and `package.json (v0.3.0 - verified versions).json`
  (`libp2p ^3.3.8`). The v0.3.0 file is the one `STATUS.md` is describing, and the one
  pinned here. A reader who trusted the sentence and took `package.json` would get the
  manifest that file exists to warn against.
  The "v0.4.0" in `STATUS.md`'s header is *not* itself an error — folder 29's README calls
  folder 16 "v0.4.0" too, so that is the session's name for the folder's final state. The
  error is narrowly the claim that a v0.4.0 `package.json` is present. Its version-note
  paragraph also says "the 49-test suite" while its own table totals 59; the table is the
  part consistent with the files.
- **`README.md` is stale where it says so and also where it does not.** It announces itself
  as v0.2.0 / 46 tests and its "Known risks, untested" list is superseded by `STATUS.md`,
  as `STATUS.md` states. Less visibly, its contents table omits `relay.test.ts` and
  `robustness.test.ts` — the two files that resolve those risks — because they were added
  to the folder after it was written. Its coverage table is the v0.2.0 one.
- **The work order's §4 opening is stale in four ways.** See README.md → "What §4 gets
  wrong".

## What this app does not establish

It is the 17 August rung, not the current design, and the gap is large. Since then the
design moved to the shared stack (note 28, "T-1 DECIDED"), and `packages/httpeers.core` in
this repo already carries `transport-duplex.ts` — the same `/httpeers/1.0.0` protocol id and
the same 512-stream cap, over `@statewalker/webrun-http-streams` instead of a hand-rolled
envelope. README.md → "How this relates to `transport-duplex.ts`" sets out which properties
survived the move and which are this app's alone.

Specifically untested here, per `STATUS.md` and unchanged by this adoption:

- **Browser↔browser over WebRTC.** Node-to-node over a relay is not the same thing, and
  `STATUS.md` calls the isomorphism claim the largest open item. Nothing here touches it.
- **Client-side concurrency bounding.** `DEFAULT_MAX_STREAMS` moves the cliff; it does not
  remove it. G7 now pins where the cliff is on both sides, which is not the same as
  bounding it. `httpeers.core`'s `createRemote` is where the bound was eventually built.
- **Raising the stream cap from 32 to 512 is a DoS-surface change that was never analysed**
  at this rung. `transport-duplex.ts` pairs it with `DEFAULT_DRAIN_TIMEOUT_MS` and states
  the exposure window as one contract; this rung has neither the timeout nor the analysis.
- 1xx interim responses are treated as terminal. `NULL_BODY_STATUS` contains 101 and 103,
  so they round-trip bodiless rather than being held open; no test asserts either way.
- Trailers: unsupported, untested, probably worth declaring unsupported.
