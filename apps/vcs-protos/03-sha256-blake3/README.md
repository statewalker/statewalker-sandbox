# 03 — Can @noble/hashes provide streaming SHA-256 (LFS) and keyed BLAKE3 (Xet) with reference-exact results?

Plan id **X1c** (part of X1 "PlatformServices"). Status: **in progress**.

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
- any SHA-256 digest or LFS pointer differs from `sha256sum` / `git lfs pointer`;
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
