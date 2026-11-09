# 01 — Can the existing streaming SHA-1 compute git object ids in one bounded-memory pass?

Plan id **X1a** (part of X1 "PlatformServices"). Status: **in progress**.

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
