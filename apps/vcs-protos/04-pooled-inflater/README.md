# 04 — Does reusing pako inflate state close the small-object gap without losing exactness?

Plan id **X1d** (follow-up to X1b, open thread 1). Status: **answered — yes: 3.1× on small objects, on par with `inflateSync`; 1.75× at 8 KiB.**

## Question

X1b's push inflater inflates small objects at about a third of `node:zlib`'s rate (39k vs 118k
objects/s), and most pack entries are small, so this sets clone speed in browsers and Durable
Objects. The suspected cause is per-object setup: a new `ZStream`, a new inflate state
(including its 32 KiB window) and a 64 KiB output buffer for every object. (pako's reset still
allocates fresh Huffman code tables — `Int32Array(852)` and `Int32Array(592)`, about 5.8 KB — so a
reset is not allocation-free; only the window and the output buffer are truly reused.) Can a **pool** that
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
makes tree- and commit-sized objects inflate **3.1× faster** than one inflater per object, and on
par with Node's native `inflateSync` on this host. For 8 KiB objects the gain is 1.75× and native
stays about 2.3× ahead: setup is a smaller share there, and the rest is pako's inflate speed, which
pooling cannot touch. Every X1b guarantee holds, including after a failed stream.

Measured 2026-11-09, Node v22.23.4, 4-core Xeon @ 2.1 GHz, one bench invocation
(`pnpm bench 04`): 7 rounds after warm-up, a forced GC before every timed run, run order rotated
per round; ratios are the median of per-round ratios (min–max).

| objects | unpooled (objects/s) | pooled (objects/s) | `inflateSync` (objects/s) | pooled ÷ unpooled | pooled ÷ `inflateSync` |
|---|---|---|---|---|---|
| 20k × ~240 B (tree/commit-sized) | 39 044 | 124 362 | 118 521 | 3.12× (2.40–3.99) | 1.05× (0.81–1.55) |
| 5k × ~8 KiB (small source files) | 19 033 | 33 307 | 75 397 | 1.75× (1.72–2.12) | 0.44× (0.38–0.60) |

`inflateSync` is a one-shot call with its own per-call overhead and no consumed count, so it is a
reference point, not a like-for-like competitor. The method matters: a first single-run
measurement gave 1.88× then 1.40× for the same set, and a fixed run order (unpooled, pooled,
native) billed the unpooled variant's ~2 GB of garbage per round to the pooled timing — the
reported 2.25× of the first version was depressed by that.

## Verified

All 14 tests pass on Node 22.23 and 24.22 (`pnpm test 04-pooled-inflater`). R3's header/body case, R5's stale-handle case, R7 and R8 were added after the independent review of #50.

| # | Result |
|---|---|
| R1 | 200 mixed streams (0 B–64 KiB, compressible and random) + trailing bytes through one pool, chunk sizes 1/7/4096/whole: exact outputs and lengths |
| R2 | 200 sequential streams allocate one `ZStream` |
| R2b | Six released at once leave four idle (JGit `InflaterCache.SZ`); the next six acquisitions allocate two |
| R3 | After a truncated stream, a corrupted trailer, a corrupted header and a corrupted body, the next stream is exact **and reuses the failed state** (`allocated` stays 1). A corrupted header is an `InflateError`; a corrupted body may decode as garbage that never ends, which `end()` reports as truncation — both are rejections |
| R4 | Two inflaters with interleaved 3-byte pushes get distinct state and exact results |
| R5 | Pushing to an inflater whose stream has ended throws — including while its old state now belongs to a second inflater, which still inflates exactly |
| R6 | Throughput table above |
| R7 | An idle pooled state does not keep the caller's last input chunk alive (WeakRef + forced GC on a 4 MiB chunk) |
| R8 | No `node:` imports in `src/` |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 no `zlibInflateReset` on release | R1, R3 |
| M2 unbounded idle cache | R2b |
| M3 shared buffer returned as views | R1, R4 |
| M4 push allowed after finish | R5 |
| M6 idle state keeps `strm.input` (the review's finding) | R7 — red before the fix |
| M5 failed stream dropped instead of returned | R3 — **survived at first**: R3 only checked that the next stream worked, which a fresh allocation also satisfies. R3 now asserts the state is reused. |

## Trap found by the review

**pako's `inflateReset` does not clear `strm.input`.** An idle pooled state therefore pinned whatever
chunk it last saw — in a pack reader, often the whole pack buffer — for as long as it sat in the pool.
Java's `Inflater.reset()` drops its input, which is why JGit's `InflaterCache` needs no such step and
why porting its design literally missed it. `release` now clears `input`, `next_in` and `avail_in`
before resetting, and R7 asserts the chunk becomes collectable. `release` also checks
`zlibInflateReset`'s result and frees the state instead of pooling it if the reset fails.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "Pure-JS inflate is a third of native on small objects" (X1b) | That was mostly per-object setup. Pooled, tiny objects run on par with `inflateSync` on this host (median 1.05×, one invocation); the real pure-JS gap shows on larger objects (about 2.3× at 8 KiB). |
| "Pooling gives 2.25×" (first version of this README) | The bench ran variants in a fixed order and billed one variant's garbage to the next. With a GC before each run and rotated order: 3.12×. |

## Functional description

`createInflaterPool()` hands out push inflaters with X1b's interface. An inflater owns a `ZStream`
while active; when its stream ends, fails or is found truncated, the stream is
`zlibInflateReset` and returned to the pool (or freed if four are idle or the reset fails), after its
input reference is cleared. All inflaters of a pool
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
| `bench.ts` | **Source** | Method for every ratio claim in CI baselines: warm-up, GC before each run, rotated order, median of per-round ratios |

## Open threads (ranked by how much later work they would invalidate)

1. **Larger objects stay 2.3× slower than native.** A WASM zlib with a consumed count is the remaining lever (same open thread as X1b 3 and X1c 1: one WASM-loading decision for workerd covers all three).
2. **Pool scope in an engine**: one pool per repository instance or per PlatformServices — decide in X16 (no module globals, per the plan).
3. **Browser, worker, CellB, workerd** numbers missing (X0).
