# 04 — Does reusing pako inflate state close the small-object gap without losing exactness?

Plan id **X1d** (follow-up to X1b, open thread 1). Status: **answered — yes for small objects (2.25×, close to native); the gain shrinks as objects grow.**

## Question

X1b's push inflater inflates small objects at about a third of `node:zlib`'s rate (39k vs 118k
objects/s), and most pack entries are small, so this sets clone speed in browsers and Durable
Objects. The suspected cause is per-object setup: a new `ZStream`, a new inflate state
(including its 32 KiB window) and a 64 KiB output buffer for every object. Can a **pool** that
resets and reuses one `ZStream` and one output buffer (`zlibInflateReset`) raise the small-object
rate substantially while keeping every X1b guarantee — exact ends, truncation and corruption as
errors, one inflation per object?

Reference design: JGit's `org.eclipse.jgit.lib.InflaterCache` — a bounded cache of at most four
`java.util.zip.Inflater` instances, `reset()` on release and handed out again — the same idea in
JGit, the codebase webrun-vcs takes its algorithms from.

## Reject condition

Rejected if the pooled inflater is less than 1.5× faster than the unpooled one on small objects,
or if any exactness, truncation or corruption guarantee breaks — including for a stream that
follows a failed one on the same pooled state.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | 200 consecutive zlib streams of mixed sizes (0 B to 64 KiB), concatenated with trailing bytes, inflated through one pool at chunk sizes 1, 7, 4096 and whole: exact outputs and exact compressed lengths. |
| R2 | Sequential use allocates exactly one `ZStream` per pool, however many streams are inflated; like JGit's `InflaterCache`, the pool retains at most 4 idle states. |
| R3 | After a truncated stream (`end()` throws `TruncatedStreamError`) and after a corrupted one (`InflateError`), the next stream from the same pool inflates correctly. |
| R4 | Two inflaters acquired at once (interleaved pushes) get distinct state and both produce exact results. |
| R5 | An inflater cannot be used after it has finished and been returned to the pool (push throws). |
| R6 | Small-object rate (20k objects) for pooled vs unpooled vs `node:zlib` measured and recorded. |

## Scope — what this prototype does NOT do

- No change to X1b's code: this folder carries its own copy so both can be compared.
- No browser/worker/CellB/workerd runs (X0). No WASM.

## Answer

**Yes.** Reusing one reset `ZStream` and one shared output buffer, as JGit's `InflaterCache` does,
makes tree- and commit-sized objects inflate **2.25× faster** (median of 7 paired rounds,
1.78–2.38) — close to `node:zlib` itself (102k vs 107k objects/s). Every X1b guarantee holds,
including after a failed stream. For 8 KiB objects the gain falls to 1.44×: setup cost is a smaller
share there, and the remaining gap to native (2.3×) is pako's inflate speed itself, which pooling
cannot touch.

Measured 2026-11-09, Node v22.23.4, 4-core Xeon @ 2.1 GHz (`pnpm bench 04`, 7 paired rounds after warm-up):

| objects | unpooled (objects/s) | pooled (objects/s) | node:zlib (objects/s) | pooled ÷ unpooled, median (min–max) |
|---|---|---|---|---|
| 20k × ~240 B (tree/commit-sized) | 44 452 | 101 947 | 106 849 | 2.25× (1.78–2.38) |
| 5k × ~8 KiB (small source files) | 27 235 | 37 327 | 84 221 | 1.44× (1.31–1.55) |

The first single-run measurements disagreed (1.88× then 1.40× for the same set), so the bench was
changed to warm up and report the median of paired rounds. A one-shot ratio is not evidence here.

## Verified

All 10 tests pass (`pnpm test 04-pooled-inflater`).

| # | Result |
|---|---|
| R1 | 200 mixed streams (0 B–64 KiB, compressible and random) + trailing bytes through one pool, chunk sizes 1/7/4096/whole: exact outputs and lengths |
| R2 | 200 sequential streams allocate one `ZStream` |
| R2b | Six released at once leave four idle (JGit `InflaterCache.SZ`); the next six acquisitions allocate two |
| R3 | After a truncated and after a corrupted stream, the next stream is exact **and reuses the failed state** (`allocated` stays 1) |
| R4 | Two inflaters with interleaved 3-byte pushes get distinct state and exact results |
| R5 | Pushing to an inflater whose stream has ended throws |
| R6 | Throughput table above |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 no `zlibInflateReset` on release | R1, R3 |
| M2 unbounded idle cache | R2b |
| M3 shared buffer returned as views | R1, R4 |
| M4 push allowed after finish | R5 |
| M5 failed stream dropped instead of returned | R3 — **survived at first**: R3 only checked that the next stream worked, which a fresh allocation also satisfies. R3 now asserts the state is reused. |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "Pure-JS inflate is a third of native on small objects" (X1b) | That was mostly per-object setup. Pooled, tiny objects run at ~95 % of `node:zlib`; the real pure-JS gap shows only on larger objects (2.3× at 8 KiB). |

## Functional description

`createInflaterPool()` hands out push inflaters with X1b's interface. An inflater owns a `ZStream`
while active; when its stream ends, fails or is found truncated, the stream is
`zlibInflateReset` and returned to the pool (or freed if four are idle). All inflaters of a pool
share one 64 KiB output buffer — safe because a push is synchronous and output is copied out with
`slice`. After its stream ends an inflater refuses further pushes, since its state may already
belong to another inflater.

## Interfaces produced

```ts
interface InflaterPool { acquire(): StreamInflater; readonly allocated: number; readonly idle: number }
function createInflaterPool(): InflaterPool;           // ≤ 4 idle states, JGit InflaterCache style
function createUnpooledInflater(): StreamInflater;     // X1b baseline, for comparison
// StreamInflater, InflatePush, TruncatedStreamError, InflateError: as in X1b
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/pooled-inflater.test.ts` | **Adopt** | Joins X1b's suite as the inflater conformance tests (pooling and reuse-after-failure) |
| `src/pooled-inflater.ts` | **Source** | The pool replaces X1b's per-object `createInflater` in the X6 pack reader |
| `bench.ts` | **Source** | Paired-round median method for every ratio claim in CI baselines |

## Open threads (ranked by how much later work they would invalidate)

1. **Larger objects stay 2.3× slower than native.** A WASM zlib with a consumed count is the remaining lever (same open thread as X1b 3 and X1c 1: one WASM-loading decision for workerd covers all three).
2. **Pool scope in an engine**: one pool per repository instance or per PlatformServices — decide in X16 (no module globals, per the plan).
3. **Browser, worker, CellB, workerd** numbers missing (X0).
