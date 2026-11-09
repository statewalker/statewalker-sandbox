# 01 — Can the existing streaming SHA-1 compute git object ids in one bounded-memory pass?

Plan id **X1a** (part of X1 "PlatformServices"). Status: **answered — the approach works; the vendored class is not the best implementation of it.**

## Question

Can webrun-vcs's existing incremental `Sha1` class (`vcs-utils/src/hash/sha1/sha-1.ts`,
a port of js-sha1) compute a git object id — `sha1("<type> <size>\0" + content)` —
in a **single pass** over a byte stream whose size is declared up front, in
**bounded memory**, with results identical to `git hash-object`? And how does it
compare with `@noble/hashes` and `node:crypto` behind one `Hasher` interface?

Context: today every object write in vcs-core stores the content once to learn its
size, then reads it back to hash it (two passes). Mikhail decided on plain SHA-1,
building on this streaming class.

## Reject condition

The approach is rejected if **any** of these hold:

- the vendored `Sha1` produces an id different from `git hash-object` for any corpus input;
- the digest depends on how the input is chunked;
- single-pass hashing needs memory proportional to the content size;
- the vendored `Sha1` is more than 10× slower than `@noble/hashes` (then noble becomes the baseline
  and the class is dropped).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For every corpus input and every implementation (`vcs`, `noble`, `node`), the id equals `git hash-object` (blob, and a commit with `mergetag`/unknown headers via `--literally`). |
| R2 | The digest is independent of chunking: every 2-way split of a 1000-byte input, 1-byte chunks, and random chunkings give the same id. |
| R3 | The content stream is iterated exactly once (an iterable that throws on a second iteration passes). |
| R4 | Hashing 256 MiB delivered as a reused 64 KiB buffer grows `arrayBuffers` memory by less than 16 MiB. |
| R5 | A declared size that differs from the actual byte count (more or fewer) rejects with `SizeMismatchError`; no id is returned (report, never guess). |
| R6 | The three implementations agree on 200 random inputs of random sizes and chunkings. |
| R7 | Throughput of each implementation is measured and recorded below. |

## Scope — what this prototype does NOT do

- No SHA-256 or BLAKE3 (separate prototype, X1c).
- No WASM tier (`hash-wasm`) and no SHA-1 collision detection (future issue).
- No browser, worker, CellB or workerd runs — the runtime-matrix harness is X0; this runs in Node 22 only.
- No integration into vcs-core, no pack trailer checksums, no object storage.

## Answer

**Yes: single-pass git hashing with a declared size works, in bounded memory, and every
implementation matches `git hash-object` byte for byte.** But the existing `Sha1` class is
**4.2× slower than `@noble/hashes`** on large streams (56 vs 235 MB/s). That is inside the
10× reject threshold, so the approach is not rejected, but the measurement argues for
`@noble/hashes` as the portable default and `node:crypto` as a Node accelerator, with the
vendored class kept only as a reference.

Measured 2026-11-09, Node v22.23.4, 4-core Xeon @ 2.1 GHz, one run (`pnpm bench 01`):

| impl | 256 MiB stream (MB/s) | 20k × 200 B objects (objects/s) |
|---|---|---|
| vcs (vendored `Sha1`) | 56 | 107 586 |
| noble (`@noble/hashes` 2.4.0) | 235 | 173 861 |
| node (`node:crypto`) | 1 446 | 175 170 |

For small objects — most of a git repository — the gap shrinks to 1.6×, because per-object
overhead dominates. For a 1 GiB file the difference is about 18 s (vcs) versus 4.5 s (noble).

## Verified

All 43 tests pass (`pnpm test 01-streaming-git-hash`, ~7 s).

| # | Result |
|---|---|
| R1 | 8 corpus inputs × 3 implementations equal `git hash-object --literally`, including a commit with `mergetag` and an unknown header, and a 5 MiB + 1 input |
| R2 | All 1001 two-way splits of a 1000-byte input, 1-byte chunks and 50 random chunkings give the same id |
| R3 | The stream is iterated exactly once |
| R4 | 256 MiB through a reused 64 KiB buffer: `arrayBuffers` growth under 16 MiB for all three |
| R5 | Over- and under-length streams reject with `SizeMismatchError` |
| R6 | 200 random inputs: the three implementations agree |
| R7 | Throughput table above |

### Mutation check

The suite passed on its first green run, so deliberate defects were injected one at a time:

| Mutation | Caught by |
|---|---|
| M1 remove both size checks | R5 (6 tests) |
| M2 copy every chunk, hash at the end | R4 (3 tests) |
| M3 iterate the stream twice (count, then hash) | R1 R2 R3 R4 R6 |
| M4 header separator space instead of NUL | R1 R2 R3 |
| M5 drop the first byte of each chunk | R1 R2 R3 |

No mutation survived. R6 does not catch M4/M5 because all implementations share the
wrapper — R6 only guards the hashers against each other, which is its purpose.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "Build on the streaming SHA-1 already in vcs-utils" (session decision) | It is correct and streams properly, but is 4.2× slower than `@noble/hashes` on large inputs and 1.6× on small objects. The decision "plain SHA-1, streaming" stands; the implementation choice should move to noble (to be confirmed by Mikhail). |
| "Hashing needs the content twice because the header needs the size" (current vcs-core write path) | Only the **size** is needed up front, not the content. Every source the plan uses knows it: FilesApi `stats`, pack entry headers, LFS pointers, HTTP `Content-Length`. Where none exists, spool to a volatile store first — that is the only case needing two passes. |

## Functional description

`hashGitObject(type, size, content, impl)` writes the header `"<type> <size>\0"` into an
incremental hasher, then feeds each chunk as it arrives and keeps nothing. It counts bytes
and throws `SizeMismatchError` as soon as the stream overruns the declared size (no
further bytes are hashed) or, at the end, if it fell short. The three hashers sit behind a
two-method `Hasher` interface, the shape `PlatformServices.hash.create()` is expected to
return.

Difficulty: the vendored class fails this workspace's `noUncheckedIndexedAccess`; it is
kept byte-identical under a `@ts-nocheck` header rather than edited.

## Interfaces produced

```ts
type GitObjectType = "blob" | "tree" | "commit" | "tag";
type Sha1Impl = "vcs" | "noble" | "node";
interface Hasher { update(bytes: Uint8Array): Hasher; digest(): Uint8Array }
function createSha1(impl: Sha1Impl): Hasher;
function hashGitObject(type: GitObjectType, size: number,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, impl: Sha1Impl): Promise<string>;
class SizeMismatchError extends Error { declared: number; actual: number /* -1 = overrun */ }
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/git-object-hash.test.ts` | **Adopt** | Becomes the X4 / R2 acceptance suite in vcs-core, run per runtime |
| `src/git-object-hash.ts` | **Source** | The single-pass loop and `SizeMismatchError` move into vcs-core's object writer |
| `src/vendor/sha-1.ts` | **Reference** | Slower than noble; keep only if a zero-dependency fallback is wanted |
| `bench.ts` | **Source** | Seed of the CI benchmark baseline |

## Open threads (ranked by how much later work they would invalidate)

1. **Browser, worker, CellB and workerd numbers are missing.** noble's lead may differ in V8
   isolates without node:crypto; the X0 runtime matrix must re-run this suite and bench.
2. **`hash-wasm` tier not measured** — if it reaches node:crypto speed in browsers, it changes the
   default for large files (and whether WASM loads in workerd is itself open).
3. **Objects ≥ 4 GiB not tested** — the vendored class tracks high bytes (`hBytes`); noble's
   length handling should be checked with a synthetic 4 GiB + 1 stream (slow; nightly).
4. **Decision needed:** noble as default with the vendored class dropped, or kept as fallback.
