# 04 — Does reusing pako inflate state close the small-object gap without losing exactness?

Plan id **X1d** (follow-up to X1b, open thread 1). Status: **in progress**.

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
