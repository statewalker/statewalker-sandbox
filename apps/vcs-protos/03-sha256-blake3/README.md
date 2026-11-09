# 03 — Can @noble/hashes provide streaming SHA-256 (LFS) and keyed BLAKE3 (Xet) with reference-exact results?

Plan id **X1c** (part of X1 "PlatformServices"). Status: **answered — yes, reference-exact; BLAKE3 is slow enough that a WASM tier matters for Xet.**

## Question

Large-file support needs two more hashes besides git's SHA-1: **SHA-256** for Git LFS object ids
(pointer files, batch API) and **BLAKE3**, including its keyed mode, for Hugging Face Xet chunk and
Merkle hashes. No repository in the stack has a BLAKE3 implementation today, and SHA-256 exists
only as WebCrypto one-shot calls (which cannot stream). Can `@noble/hashes` — already chosen as the
portable SHA-1 default in X1a — provide both incrementally, with results identical to the
reference vectors and to `git lfs`, in bounded memory, at a usable speed?

## Reject condition

Rejected if any of these hold:

- any official BLAKE3 test vector (hash, keyed_hash, derive_key) differs;
- any SHA-256 digest or LFS pointer differs from `sha256sum` / `git lfs pointer` (the SHA-256 oracle became `node:crypto` after review: same function, no host dependency);
- digests depend on chunking, or streaming needs memory proportional to input;
- noble BLAKE3 runs below 20 MB/s in Node (a 5 GB file would take over four minutes to hash, making
  a WASM tier mandatory rather than optional).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | All 35 official BLAKE3 vectors (`test_vectors.json` from BLAKE3-team/BLAKE3, input byte i = i mod 251, key "whats the Elvish word for friend", context "BLAKE3 2019-12-27 16:29:52 test vectors context") match for `hash`, `keyed_hash` and `derive_key`, at the extended output lengths given. |
| R2 | For vector inputs up to 4097 bytes, feeding the input split at every offset (and in 1-byte chunks for all inputs) gives the same digests, for SHA-256 and all three BLAKE3 modes. |
| R3 | `clone()` mid-stream yields a hasher whose digest equals hashing the prefix, while the original continues to the full digest. |
| R4 | SHA-256 of corpus files equals `sha256sum`; the LFS pointer built from the streaming hash and size equals `git lfs pointer --file` byte for byte. |
| R5 | 128 MiB in fresh 64 KiB chunks with forced GC: memory growth under 32 MiB for SHA-256 and BLAKE3. |
| R6 | No module in `src/` imports from `node:`. |
| R7 | Throughput of noble SHA-256 vs `node:crypto`, and noble BLAKE3 (plain and keyed), measured and recorded. |

## Scope — what this prototype does NOT do

- No Xet chunking, xorbs, shards or Merkle trees — this only proves the hash primitive (X11 builds on it).
- No WASM tier (`hash-wasm`), no browser/worker/CellB/workerd runs (X0).
- No LFS transfer, only the pointer format.

## Answer

**Yes.** `@noble/hashes` gives incremental SHA-256 and BLAKE3 (plain, keyed and derive-key) that
match all 35 official BLAKE3 vectors at 131-byte extended output, `sha256sum`, and `git lfs pointer`
byte for byte, independent of chunking, with `clone()` mid-stream and flat memory. The module has
no `node:` imports.

Speed is the caveat. Noble SHA-256 is 8× slower than `node:crypto`, and noble BLAKE3 runs at
37–39 MB/s: above the 20 MB/s reject line, but a 5 GB Xet upload would spend over two minutes
hashing. BLAKE3 has no native API in browsers, Node or workerd, so a WASM tier is the only way to
go faster — a real open thread for X11, not a nice-to-have.

Measured 2026-11-09, Node v22.23.4, 4-core Xeon @ 2.1 GHz, one run (`pnpm bench 03`):

| hash | 256 MiB stream (MB/s) |
|---|---|
| SHA-256 noble | 201 |
| SHA-256 node:crypto | 1 589 |
| BLAKE3 noble | 37 |
| BLAKE3 noble keyed | 39 |

## Verified

All 123 tests pass on Node 22.23 and 24.22 (`pnpm test 03-sha256-blake3`). The R2 every-offset loop and the R4 restructuring followed the independent review of #50 and the first CI run.

| # | Result |
|---|---|
| R1 | 35 official vectors × 3 modes (105 tests) match at 131-byte output; the fixture is checked to be the official file (35 cases) |
| R2 | Every 2-way split at every offset of inputs up to 4097 bytes, 1-byte chunks for all vectors and modes; SHA-256 splits equal `node:crypto` |
| R3 | `clone()` mid-stream: prefix digest and full digest both correct, for SHA-256 and keyed BLAKE3 |
| R4 | Always: SHA-256 equals `node:crypto`, a hard-coded v1 pointer for a known input, `""` for empty input. Where git-lfs is installed (local 3.4.1, GitHub's runner): pointers equal `git lfs pointer --file` for empty, text and 3 MiB inputs |
| R5 | 128 MiB in fresh chunks with forced GC: growth under 32 MiB for all three hashers |
| R6 | No `node:` imports in `src/` |
| R7 | Throughput table above |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 `clone()` returns the same hasher | R3 |
| M2 LFS size counts chunks instead of bytes | R4 |
| M3 empty-file rule removed (below) | R4 |
| M4 `key` / `context` options dropped | R1, R2 (72 tests) |

## Trap found by the oracle

**An empty file has no LFS pointer.** `git lfs pointer --file` prints nothing for an empty file:
the pointer spec makes an empty file its own pointer, and clean filters leave empty files as they
are. The first implementation produced a pointer with `size 0` and R4 failed against git-lfs.
`lfsPointer` now returns `""` for empty content, with the reason in a comment at the site.

**git-lfs's exit status for that case differs by version.** Locally (3.4.1) `git lfs pointer` on an
empty file exits 0 with no output; on GitHub's runner it exits 1 with no output, which failed the
first CI run of #50. The oracle now compares stdout only for the empty file and asserts a zero exit
status for the others, with git-lfs's stderr in every failure message.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "BLAKE3 is missing everywhere" (primitives inventory) | Missing in the stack's code, but `@noble/hashes` — already a dependency — provides it, reference-exact, including keyed and derive-key modes. |
| An LFS pointer can be built from any content's hash and size | Not for empty content (trap above). |

## Functional description

`createSha256()` and `createBlake3({ key?, context?, dkLen? })` wrap noble's incremental hashers in
the same three-method `Hasher` (`update`, `digest`, `clone`) used by X1a. `lfsPointer(stream)`
hashes and counts in one pass and formats the v1 pointer (`version`, `oid sha256:`, `size`), or
returns the empty string for empty content.

## Interfaces produced

```ts
interface Hasher { update(b: Uint8Array): Hasher; digest(): Uint8Array; clone(): Hasher }
interface Blake3Options { key?: Uint8Array; context?: Uint8Array; dkLen?: number }
function createSha256(): Hasher;
function createBlake3(opts?: Blake3Options): Hasher;
function lfsPointer(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string>;
function toHex(bytes: Uint8Array): string;
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/hashes.test.ts` + `fixtures/blake3-test-vectors.json` | **Adopt** | Hash conformance suite for every PlatformServices tier and runtime |
| `src/hashes.ts` | **Source** | The `Hasher` wrappers and `lfsPointer` (with its empty-file rule) move into PlatformServices / vcs-lfs |
| `bench.ts` | **Source** | CI baseline seed |

## Open threads (ranked by how much later work they would invalidate)

1. **BLAKE3 speed for Xet**: 37 MB/s in pure JS. Measure a WASM BLAKE3 (e.g. hash-wasm) in Node, Chromium and workerd before X11 fixes its upload path.
2. **Browser, worker, CellB, workerd** numbers missing (X0).
3. **LFS pointer parsing** (the inverse: validating pointers read from history, extension lines, key order) is not covered; it belongs to X10.
