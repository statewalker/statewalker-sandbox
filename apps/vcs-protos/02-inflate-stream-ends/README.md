# 02 — Can pako's low-level inflater, fed arbitrary chunks, report exactly where each zlib stream ends?

Plan id **X1b** (part of X1 "PlatformServices"). Status: **answered — yes; exact, single-pass, truncation-safe. Slower than native zlib.**

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
| R2 | Real packs from `git pack-objects` — one with OFS deltas (`--delta-base-offset`), one with REF deltas — walk end to end: entry count equals the header, each inflated length equals the entry's declared size, entry offsets equal `git verify-pack -v`, the trailer SHA-1 matches, and exactly one inflater is created per entry — for chunk sizes 1, 4096 and whole. |
| R3 | A stream truncated at any of several points (inside the header, the body, the Adler-32 trailer) is never reported done; `end()` throws `TruncatedStreamError`. |
| R4 | A corrupted byte in the body or the Adler-32 trailer throws `InflateError`. |
| R5 | Traps documented as passing tests: (a) the vendored `decompressBlockPartialPako` returns short data without error on truncated input; (b) `DecompressionStream("deflate")` throws on trailing bytes and exposes no consumed count; (c) Node `zlib.inflateSync` silently accepts trailing bytes. |
| R6 | Throughput of the push inflater versus `node:zlib` measured and recorded. |

## Scope — what this prototype does NOT do

- No delta resolution, no object ids, no pack index (`.idx`) writing — those are X6.
- No sizes beyond 2^53: the walker accumulates the size varint with multiplication (no 2^31 wrap) but makes no attempt at > 2^53 or > 4 GiB packs.
- No deflate side, no gzip, no fflate comparison (deflate is a separate, smaller question).
- No browser, worker, CellB or workerd runs (runtime matrix is X0); Node only (22.23 locally, 24.22 in CI).

## Answer

**Yes, in Node.** Driven through a push interface, pako 3's low-level `zlibInflate` reports the exact
end of every zlib stream under any chunking (down to 1 byte), every pack entry is inflated
exactly once, and truncation or corruption is always an error. Being pure JS it is expected to be the portable inflater the pack
reader needs in browsers, workers and Durable Objects — unverified until the X0 runtime matrix runs it.

The cost is speed: pure-JS inflate runs at roughly a quarter of `node:zlib` on text and a
third on small objects. That is a reason to keep a native accelerator where one exists —
but `node:zlib` itself cannot be the accelerator for pack parsing, because it does not
report where a stream ends (R5 c).

Measured 2026-11-09, Node v22.23.4, 4-core Xeon @ 2.1 GHz, one run (`pnpm bench 02`):

| input | pako push, 64 KiB chunks (MB/s out) | node:zlib inflateSync (MB/s out) |
|---|---|---|
| text 15 MiB | 123 | 518 |
| random 16 MiB (stored blocks) | 551 | 824 |
| 20k small objects (objects/s) | 39 105 | 118 494 |

## Verified

All 29 tests pass on Node 22.23 and 24.22 (`pnpm test 02-inflate-stream-ends`, ~5 s). R7–R9 and the second R2 pack were added after the independent review of PR #49.

| # | Result |
|---|---|
| R1 | 5 streams + trailing bytes, chunk sizes 1/2/7/64/4096/whole: exact outputs, exact compressed lengths, trailing bytes untouched |
| R2 | Two real `git pack-objects` packs, one with OFS and one with REF deltas — each asserted to contain that delta type (5 commits, a growing text file, random binaries, an empty file): entry offsets equal `git verify-pack -v`, inflated lengths equal declared sizes, trailer SHA-1 verified, one inflater per entry — at chunk sizes 1, 4096 and whole |
| R3 | Cuts inside the header, the body and the Adler-32 trailer: never `done`, `end()` throws `TruncatedStreamError` |
| R4 | Flipped Adler-32 byte and garbage body: `InflateError` |
| R5 | Four traps, documented as passing tests (below) |
| R6 | Throughput table above |
| R7 | Malformed packs rejected with `PackFormatError`: unsupported version, reserved types 0 and 5, bytes after the trailer |
| R8 | `ChunkReader` holds one pushed-back chunk; a second `unshift` throws instead of reordering |
| R9 | Raw deflate (`format: "raw"`) with trailing bytes: exact end |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 report the whole chunk as consumed | R1, R2 |
| M2 treat "input exhausted" as stream end | R1, R2, R3, R5 (d) |
| M3 swallow inflate errors | R4 |
| M4 create an extra inflater per stream | R2 |
| M5 return views of a per-push buffer (the trap below) | R5 (d) by assertion (265 MB pinned vs 32 MB limit) when run alone; in the full suite the 1-byte R1 run OOM-kills the worker first |

## Traps (filed as passing tests)

| # | Trap |
|---|---|
| R5 a | webrun-vcs `decompressBlockPartialPako` returns **short data with no error** on truncated input (10 of 12 000 bytes in the exploration). Its loop stops when input runs out and never checks for `Z_STREAM_END`. |
| R5 b | `DecompressionStream("deflate")` **rejects** when anything follows the stream (Node 22/24 message: `Trailing junk found after the end of the compressed stream`; the test asserts only rejection, since the message is runtime-specific), and has no consumed count. It cannot parse packs even if lengths were known approximately. |
| R5 c | Node `zlib.inflateSync` **silently ignores** trailing bytes and reports no position — checked on Node 22.23 and 24.22. |
| R5 d | Found while going green: returning `subarray` views of a fresh 64 KiB output buffer per push pins the whole buffer per view. With 1-byte chunks a 1 MiB object pins ~64 GiB; the test worker was OOM-killed. Fix: one output buffer per inflater, produced bytes copied out with `slice`. |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "DecompressionStream is unusable for packs because it reports no bytes consumed" | Worse: it rejects any trailing bytes outright (R5 b). |
| "Node 24 zlib throws / returns wrong `bytesRead` on trailing data" (primitives report, static) | On Node 22.23 **and 24.22**, `inflateSync` silently accepts trailing data (R5 c); the static claim about Node 24 was wrong. Either way, node:zlib gives no stream end, so the binary search in `vcs-utils-node` is the wrong tool. |
| "pako's low-level API handles trailing data" (comment in `pako-inflate.ts`) | True of the API; false of the wrapper, which ignores the missing `Z_STREAM_END` and returns short data (R5 a). |

## Functional description

`createInflater()` wraps a pako `ZStream`. Each `push(chunk)` sets the chunk as input and calls
`zlibInflate(…, Z_NO_FLUSH)` until the input is exhausted or the stream ends; output goes
into one reusable 64 KiB buffer and is copied out. On `Z_STREAM_END` — returned only after the
Adler-32 has been read and verified — `strm.next_in` is the number of bytes of this chunk that
belonged to the stream. `end()` throws `TruncatedStreamError` if that never happened.

`ChunkReader` hands out chunks and takes back the unconsumed tail (`unshift`), so the next
reader (the next entry header, or the next stream) starts exactly where the last stream ended.
`walkPack` uses it to read the 12-byte header, each entry header (type, size varint, OFS/REF
base), one inflater per entry, and the 20-byte trailer, feeding every preceding byte to an
incremental SHA-1. It rejects unsupported versions, reserved types and bytes after the trailer, and
counts inflated bytes instead of holding them. Sizes are accumulated with multiplication, not shifts, so they do not wrap at 2^31.

## Interfaces produced

```ts
interface InflatePush { out: Uint8Array[]; done: boolean; consumed: number }
interface StreamInflater { push(chunk: Uint8Array): InflatePush; end(): void }
function createInflater(format?: "zlib" | "raw"): StreamInflater;
class ChunkReader { constructor(source); next(): Promise<Uint8Array | undefined>; unshift(chunk): void /* one slot */ }
function inflateOne(reader: ChunkReader, onConsumed?: (bytes: Uint8Array) => void,
  onOutput?: (bytes: Uint8Array) => void /* when given, output is streamed, not kept */):
  Promise<{ data: Uint8Array[]; compressedLength: number }>;
function inflateSequence(source, count): AsyncGenerator<{ data: Uint8Array; compressedLength: number }>;
function walkPack(source): Promise<{ version; count; entries: PackEntry[]; trailerOk: boolean }>;
class TruncatedStreamError extends Error {}  class InflateError extends Error {}  class PackFormatError extends Error {}
```

This is the `Inflater` shape the plan's `PlatformServices.compression.inflater()` contract
proposed (`push → { out, done, consumed }`), now exercised.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/stream-inflater.test.ts` | **Adopt** | R1–R5 become the inflater conformance suite for every PlatformServices implementation and runtime |
| `src/stream-inflater.ts` | **Source** | `createInflater` and `ChunkReader` can move into vcs-utils nearly as is; replaces `decompressBlockPartialPako`, the Node binary search and the buffered-byte-reader retry loop |
| `src/pack-walk.ts` | **Guideline** | Right structure for X6's streaming `index-pack`; needs delta resolution, `.idx` writing and object ids |
| `src/vendor/pako-inflate-vcs.ts` | **Reference** | Kept only for trap R5 a |

## Open threads (ranked by how much later work they would invalidate)

1. **Small-object rate is a third of native** (39k vs 118k objects/s). Most pack entries are small, so this sets clone speed. Likely cause: a new `ZStream`, inflate state and 64 KiB buffer per object. Try `zlibInflateReset` on a pooled stream with a shared buffer before X6 commits to this design.
2. **Browser, worker, CellB and workerd untested** (X0). pako is pure JS, so correctness should carry over; throughput in a DO under CPU limits is the open question.
3. **A WASM inflater with a consumed count** (e.g. a zlib build) was not measured; it could close the speed gap everywhere, if WASM loads in workerd.
