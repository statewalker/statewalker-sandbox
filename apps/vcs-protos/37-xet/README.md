# 37 — Can webrun-vcs chunk, hash and reconstruct Hugging Face Xet files exactly?

Plan id **X11** (Hugging Face Xet). Status: **answered — yes: the specification's reference file is rebuilt from a recorded reconstruction answer, and its 796 chunk boundaries and hashes, xorb hash, file hash and range hash all match the reference data**.

## Question

Hugging Face stores large files with Xet: content-defined chunks (a gear hash), keyed BLAKE3 chunk
hashes aggregated into Merkle hashes (xorb hash, file hash, verification range hash), chunks
packed into LZ4-compressed xorbs, and files rebuilt from a reconstruction answer (terms over xorb
chunk ranges, fetch ranges). Can a portable TypeScript implementation match the specification's
reference data bit for bit, and rebuild a file from a recorded reconstruction answer?

## Reject condition

Rejected if a chunk boundary, a chunk hash, the xorb hash, the file hash, the range hash or a
reconstructed byte differs from the reference data.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| H1 | **Hash strings.** The specification's example: bytes 0…31 print as `07060504030201000f0e0d0c0b0a090817161514131211101f1e1d1c1b1a1918`, and parse back. |
| H2 | **Aggregated hashes.** From the reference chunk list (796 hashes and lengths): the xorb hash, the file hash and the verification hash of the full range equal the reference values. |
| H3 | **Reconstruction.** From the recorded reconstruction answer and the reference xorb (fetched by URL range): the rebuilt file is 63,527,244 bytes whose chunking (gear hash, 8 KiB…128 KiB, mask `0xFFFF000000000000`) gives the reference's 796 boundaries and chunk hashes, and whose file hash is the reference's. The xorb's chunk headers and LZ4 frames are read as the specification defines them. |
| H4 | **Streaming.** Reconstruction yields chunks as it goes: the memory it retains (measured after forced collections every 50 chunks) stays within a few chunks plus the fetched pieces, not the whole file. |
| H6 | Added after the first green: a term over a chunk sub-range with an offset into it gives the matching slice of the file; ByteGrouping4 groups come back in order. |
| H7 | Added after the mutation check: a hash match one byte before 8 KiB is no boundary, one at 8 KiB is, as the specification's chunker (written out literally in the test, every byte hashed with BigInt) says. |
| H8 | Added after review: the fetched body is closed when a term ends before its fetch range, and no chunk past the term is read; a fetch range taking in the xorb's `XETB` tail; a requested length truncating the last term; LZ4 frames with uncompressed and linked blocks, a content size and checksums decode, and frames that lie (literals past their block, no end mark, a match into an earlier independent block) are refused; random data in piece sizes from 1 byte to 1 MiB chunks as the specification's chunker does. |
| H5 | **Portable.** `src/` has no `node:` imports. |

## Scope

- Download (reconstruction) only; uploading xorbs and shards is later work.
- The reconstruction answer is the v1 shape (`fetch_info`, inclusive `url_range`), as
  `/v1/reconstructions` returns it; v2's `xorbs[].ranges[]` and multipart range fetches are not
  implemented.
- ByteGrouping4-LZ4 (compression type 2) is decoded as xet-core defines it, but the reference xorb
  uses LZ4 only, so it is checked by a round trip, not against reference data.

## Answer

Yes. `src/xet.ts` (about 290 lines), `src/lz4.ts` (an LZ4 frame decoder, about 85 lines) and
`src/gear-table.ts` (rust-gearhash's table) implement it with no `node:` imports and no new
dependency: BLAKE3 is X1c's (@noble/hashes). All 13 tests pass:

- **H1.** The specification's hash-string example, both ways.
- **H2.** From the reference chunk list: the xorb hash `eea25d6e…`, the file hash `118a5332…` and
  the full range's verification hash `d81c11b1…`.
- **H3.** From the recorded answer of `cas-server.xethub.hf.co` (one term, chunks 0–796 of one
  xorb, bytes 0–14,737,812) and the reference xorb: 63,527,244 bytes, whose 796 chunks and chunk
  hashes are the reference's and whose file hash is `118a5332…`.
- **H4.** Rebuilding the 63 MB file retains under 8 MB (measured after forced collections).
- **H6, H7, H8.** Range requests and lengths; ByteGrouping4; boundaries around the minimum size
  and random data in any piece size against the specification's chunker; LZ4 frame variants and
  frames that lie; the fetched body closed early.

**What Xet is, as implemented:**
- **Chunks.** Gear hash `h = (h << 1) + TABLE[b]` (64-bit; kept as two 32-bit halves, since
  BigInt per byte is slow), a boundary after a byte where `h & 0xFFFF000000000000 == 0` once the
  chunk has 8 KiB, always at 128 KiB, the hash restarting at each boundary. The first
  `8 KiB − 65` bytes of a chunk need no hashing: the hash looks back 64 bytes.
- **Hashes.** A chunk's hash is BLAKE3 keyed with DATA_KEY. Internal nodes hash the text
  `{hash} : {size}\n` per child, keyed with INTERNAL_NODE_KEY; children are grouped as xet-core's
  `next_merge_cut` does (2 to 9; a child whose last 64-bit word is 0 mod 4 ends a group from the
  third on). The xorb hash is the root; the file hash is the root keyed once more with 32 zero
  bytes; a verification hash is the chunk hashes concatenated, keyed with VERIFICATION_KEY.
  Hash strings print the four 64-bit little-endian words in hex.
- **Xorbs.** Chunks of an 8-byte header (version 0, compressed size, compression type,
  uncompressed size; sizes 3 bytes little-endian) and a payload: none, an LZ4 frame, or an LZ4
  frame of ByteGrouping4 groups. The reference xorb ends with the marker `XETB`, which nothing reads:
  a term decodes exactly its chunks, so a range taking in the tail stops before it.
- **Reconstruction.** For each term, the fetch entry of its xorb covering its chunk range is
  fetched (the URL and an inclusive byte range) and decoded chunk by chunk as bytes arrive; the
  term's chunks are yielded, minus `offset_into_first_range` bytes at the start.

**The reference data.** The specification publishes no inline vectors; its reference files are a
dataset (Apache-2.0). The chunk list, the three hashes and the recorded answer (signed URLs
replaced by `xorb://<hash>`) are committed under `fixtures/`; the xorb (14.7 MB) is downloaded by
the tests from the dataset's pinned revision, checked by SHA-256 and cached. Building and running xet-core itself to generate more vectors was not done.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| K1 | Hashing from a chunk's first byte (no skip) | equivalent: the gear hash looks back 64 bytes, and no boundary comes before 8 KiB |
| K2 | Minimum size one byte short | survived (the reference file has no match at 8,191); killed by H7 |
| K3 | Natural cuts tested on the first word | killed (H2, H3) |
| K4 | File hash without the zero-key step | killed (H2, H3) |
| K5 | Hash strings in byte order | killed (H1, H2) |
| K6 | Node lines without the spaces | killed (H2, H3) |
| K7 | Overlapping LZ4 matches copied as memmove | killed (H3) |
| K8 | `offset_into_first_range` ignored | killed (H6) |
| K9 | ByteGrouping4 groups sized from the end | killed (H6) |
| K10 | Groups of at most 8 | killed (H2, H3) |
| K11 | Range hash over hex text | killed (H2) |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/xet.ts`, `src/gear-table.ts` | **Adopt** | the specification's reference data, bit for bit |
| `src/lz4.ts` | **Adopt** for Xet chunks | small, dependency-free; frames verified through chunk hashes |

## Open threads

1. Upload: xorb and shard writing, deduplication against shards, the CAS upload API.
2. Fetching several terms of one xorb with one request (the answer's fetch entries allow it).
3. Reconstruction against the live CAS (tokens, signed URLs, retries, `Range` resume).
4. Verifying a fetched xorb range by its chunk hashes as it streams (here the file hash checks the
   whole).

### Review

| Finding | Fix |
|---|---|
| The fetched body was never closed (a term ending early leaked it) | closed in a `finally` (H8) |
| One chunk past the term was read; a range taking in the `XETB` tail failed | a term decodes exactly its chunks (H8) |
| v1 answer shape not stated; no truncation of the last term | v1 stated in the scope; a `length` option (H8) |
| The LZ4 decoder accepted frames that lie | every literal, match and block bounds-checked; end mark required; independent blocks keep their window; stored chunks sized (H8) |
| LZ4 paths untested (the reference uses single independent blocks only) | hand-built frames for each path (H8) |
| Download unpinned, size-checked, racy | pinned revision, SHA-256, private file renamed into place |
| README claims (footer read, peak memory) | corrected |
| Quadratic buffer copies; no fetch coalescing | a read offset instead of copies; coalescing is an open thread |
| The CSV's own origin | stated in `fixtures/README.md` |
