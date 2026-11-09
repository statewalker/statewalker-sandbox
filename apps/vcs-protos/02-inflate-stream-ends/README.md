# 02 — Can pako's low-level inflater, fed arbitrary chunks, report exactly where each zlib stream ends?

Plan id **X1b** (part of X1 "PlatformServices"). Status: **in progress**.

## Question

Git packs concatenate zlib streams with no length prefix: a parser only learns where an
object's compressed bytes end by inflating it. Can pako 3's low-level zlib API
(`zlibInflate` on a `ZStream`), driven by a **push** interface that receives arbitrary
chunks as they arrive from the network or storage, report the **exact** end of each
stream, so that every object is inflated **exactly once** — in pure JS that runs in a
browser, a worker, Node and a Durable Object?

Context: today webrun-vcs either calls this API on a whole buffer (`decompressBlockPartialPako`,
which silently returns short data on truncated input) or binary-searches Node zlib, and
its streaming reader re-inflates the growing buffer every 64 bytes. `DecompressionStream`
reports no bytes-consumed count.

## Reject condition

Rejected if, for any chunking of the input:

- the reported end of a stream differs from its true compressed length; or
- a truncated or corrupted stream is reported as complete (short or wrong data with no error); or
- an object has to be inflated more than once to find its end.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Concatenated zlib streams (empty, 1 byte, text, 1 MiB incompressible, 1 MiB zeros) followed by trailing bytes, pushed in chunks of 1, 2, 7, 64, 4096 bytes and whole: each stream's output equals its input and its reported compressed length is exact; the bytes after the last stream are left unconsumed. |
| R2 | A real pack from `git pack-objects` (with OFS deltas) walks end to end: entry count equals the header, each inflated length equals the entry's declared size, entry offsets equal `git verify-pack -v`, the trailer SHA-1 matches, and exactly one inflater is created per entry — for chunk sizes 1, 4096 and whole. |
| R3 | A stream truncated at any of several points (inside the header, the body, the Adler-32 trailer) is never reported done; `end()` throws `TruncatedStreamError`. |
| R4 | A corrupted byte in the body or the Adler-32 trailer throws `InflateError`. |
| R5 | Traps documented as passing tests: (a) the vendored `decompressBlockPartialPako` returns short data without error on truncated input; (b) `DecompressionStream("deflate")` throws on trailing bytes and exposes no consumed count; (c) Node 22 `zlib.inflateSync` silently accepts trailing bytes. |
| R6 | Throughput of the push inflater versus `node:zlib` measured and recorded. |

## Scope — what this prototype does NOT do

- No delta resolution, no object ids, no pack index (`.idx`) writing — those are X6.
- No 64-bit sizes: the pack walker uses the varint as is (the 2^31 fix is an R1 release item).
- No deflate side, no gzip, no fflate comparison (deflate is a separate, smaller question).
- No browser, worker, CellB or workerd runs (runtime matrix is X0); Node 22 only.
