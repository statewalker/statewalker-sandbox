# 37 — Can webrun-vcs chunk, hash and reconstruct Hugging Face Xet files exactly?

Plan id **X11** (Hugging Face Xet). Status: **answered — yes (X11b: xorbs and shards written, the reference shards byte for byte): the specification's reference file is rebuilt from a recorded reconstruction answer, and its 796 chunk boundaries and hashes, xorb hash, file hash and range hash all match the reference data**.

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
| U1 | (X11b) **Shards byte for byte.** From the reference chunk list, the xorb and file hashes, the range hash and the file's SHA-256, `writeShard` gives the specification's four reference shards exactly: the base shard, the one with verification entries, the upload form (no footer) and the global-dedupe answer (keyed chunk hashes); each reference shard read and written again is the same bytes. |
| U2 | (X11b) **Deduplication.** Every chunk of the reference file is found in the global-dedupe shard by its keyed hash, at its index; the terms built from those locations (with their range hashes) serialize to the reference upload shard. Terms split where chunks leave a xorb or skip an index; damaged shards are refused. |
| U5 | (X11b) **Streaming verification.** With a shard's hashes (`verifierFromShard`), each chunk is checked as it is decoded, before it is yielded: the reference reconstruction passes with each reference shard (796 chunks checked, keyed ones keyed); a chunk with one byte changed stops the stream at that chunk (none after it yielded), where unchecked it passes unnoticed; with the term's verification hash only, the damage is caught at the term's end; a term inside its fetch range is checked over its own chunks. |
| U7 | (X11b) **One fetch for several terms.** Consecutive terms of one fetch entry whose chunk ranges go forward share one fetch (a gap between them decoded and not output); terms going backwards, repeated, or of different entries are fetched each; each term of a shared fetch is checked when it ends, before the next term's bytes; offsets and lengths across a shared fetch. |
| U8 | (X11c) **The live services' protocol, offline.** `httpRanges` resumes a body cut mid-stream from its next byte (the `Range` asked says so), tries 429, 5xx and network errors again with growing pauses up to its retries, reads a server that ignores `Range` from the start, refuses another range and a 404 (not retried); v2 answers become v1's fetch entries; `downloadXetFile` over a fake Hub, CAS and CDN with bodies cut three times rebuilds the reference file, checked chunk by chunk and term by term against its shard (`wholeFile`). |
| U9 | (X11c) **The live Hub and CAS** (`XET_LIVE=1`, not in CI): the reference file downloaded through `paths-info`, an anonymous read token, the reconstruction answer (v1 and v2) and the CDN, checked against its shard; a byte range equal to the same bytes of a larger range. |
| U3 | (X11b) **Xorbs written.** `writeXorb` serializes chunks (LZ4, ByteGrouping4-LZ4 or none, a chunk LZ4 would not shrink stored), ending after the last chunk; the reference file's 796 chunks written so and read back through `reconstruct` give the reference chunk hashes. LZ4 frames round trip on edge cases and keep LZ4's end-of-block rules; xxHash32 (the header checksum) matches its published values. |

## Scope

- Download (reconstruction), and (X11b) writing xorbs and shards and deduplicating against shards;
  the CAS upload API itself (tokens, `POST /v1/xorbs`, `POST /v1/shards`) is not called.
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

### X11b: writing xorbs and shards

`src/shard.ts` writes and reads shards; `writeXorb` (in `src/xet.ts`) and an LZ4 frame encoder
(in `src/lz4.ts`) write xorbs. No new dependency, no `node:` imports.

- **Shards (U1).** The reference shards are four, all committed under `fixtures/` (38 KB each):
  - the base shard (file info with the file's SHA-256, CAS info, a footer);
  - the same with verification entries;
  - the upload form: the same without its footer;
  - a global-dedupe answer: no file info, chunk hashes keyed with the footer's key.

  `writeShard` reproduces each byte for byte from the reference chunk list and hashes. What the
  specification left to the reference files:
  - the 32-byte header tag;
  - the SHA-256 in the metadata extension is stored in Xet's hash layout (each eight-byte word
    reversed, `metadataSha256`), not as the raw digest;
  - the reference shards have no lookup tables (each lookup offset at the footer, no entries)
    and leave `num_bytes_on_disk` 0; `readShard` does not keep lookup tables, so a shard that
    has them is written again without;
  - the footers' timestamps and the dedupe key are the reference shards' own inputs.
- **Deduplication (U2).** `dedupeIndex` finds a chunk in shards by its hash, or by its keyed hash
  in a shard whose footer has a key (BLAKE3 keyed with it; not RFC 2104 HMAC). `termsFor` turns
  the chunks' locations into terms with their range hashes. For the reference file, every chunk
  is found in the dedupe shard, and the upload shard built from it is the reference's.
- **Xorbs (U3).** Chunks written with an 8-byte header each and no trailing bytes (the
  specification forbids the `XETB` tail the reference xorb carries). LZ4 is a greedy block
  encoder (one block per chunk, 64 KiB window, the format's end-of-block rules kept) in a frame
  with the header checksum (xxHash32). The reference file's chunks make a 14,408,825-byte LZ4
  xorb (the reference xorb is 14,737,817), read back to the reference chunk hashes.
- **Checked against lz4_flex** (xet-core's LZ4), once, through `lz4-napi` (its Node binding)
  installed outside the repository: 3,813 inputs (edge sizes, 3,000 random ones, 6 MiB, a long
  run, and the reference file's 796 chunks). lz4_flex reads every frame we write, and we read
  every frame it writes; no failure either way. lz4_flex's own frames of the reference chunks
  are 14,731,445 bytes: with the 796 chunk headers and the `XETB` tail, exactly the reference
  xorb's 14,737,817, so the reference xorb was written with lz4_flex's default frames (64 KiB
  blocks); ours are 0.2% smaller. Not part of the suite (a native dependency, and this worktree's
  pnpm store); to rerun: `npm install lz4-napi` in a scratch directory and decode
  `lz4FrameEncode`'s frames with its `decompressFrameSync`.

| # | Mutant | Result |
|---|---|---|
| W1 | Compressed chunk offsets in the CAS section | killed (U1) |
| W2 | Plain chunk hashes in a keyed shard | killed (U1) |
| W3 | Terms never split | killed (U2) |
| W4 | Matches farther back than 64 KiB | killed (U3) |
| W5 | xxHash32 with a wrong seed term | killed (U3) |
| W6 | No end-of-block rules | survived (our decoder does not check them); killed by U3's block check |
| W7 | ByteGrouping4 groups in reverse | killed (U3) |
| W8 | The SHA-256 stored as the raw digest | killed (U1, U2) |

**Review of #121** (no blocking findings; the encoder fuzzed against a strict decoder and its
header checksum confirmed for `60 70`) found, and U4 covers:

| Finding | Fix |
|---|---|
| A chunk over 4 MiB became one block under a header declaring 4 MiB blocks (liblz4 and lz4_flex refuse it; our decoder did not check) | frames split into independent blocks of at most 4 MiB; our decoder refuses a block past the declared maximum |
| `dedupeIndex` took a keyed footer to mean keyed hashes, unlike `writeShard` | it follows `chunkHashesKeyed` |
| Keyed hashes could be written into an upload shard (no footer) | refused |
| `readShard` drops lookup tables and the footer's offsets; the README said xet-core writes no tables | documented: the reference shards have none; the footer offset is checked |
| `writeXorb` took empty chunks and more than 64 MiB | refused |
| Tests: the header checksum, several files and xorbs, footer totals, hostile counts, plain and mixed dedupe, duplicate chunks, encoder fuzzing | U4 (the empty frame's bytes, 2,000 random inputs against LZ4's end-of-block rules, the rest as listed) |

| # | Mutant | Result |
|---|---|---|
| R1 | One block per frame whatever its size | killed (U4) |
| R2 | The block maximum not checked | killed (U4) |
| R3 | `dedupeIndex` ignores `chunkHashesKeyed` | killed (U4) |
| R4 | Keyed hashes allowed without the key | killed (U4) |
| R5 | No end-of-block rules | killed (U4's fuzz) |

### Streaming verification (U5)

The reconstruction answer carries no hashes, so the file hash could only check a whole download.
`reconstruct(answer, fetch, { verify })` now checks as it goes, with what a shard knows:

- **Chunks:** the CAS section lists each xorb chunk's hash. Each decoded chunk is hashed and
  compared before it is yielded, so a damaged chunk stops the stream there (U5: chunk 300 of
  796 changed by one byte; 300 chunks out, then `XetIntegrityError`). Chunks the fetch range
  holds before the term's first are checked too. A keyed (global-dedupe) shard is compared
  keyed.
- **Terms:** the File Info section's verification hash of each term is compared when the term's
  last chunk is decoded, before the next term is fetched. Its bytes are out by then, so this
  catches damage per term, not per chunk; a `length` that ends inside a term leaves it
  unchecked.
- **Unknown chunks:** chunks of a xorb the shard does not list are passed unchecked.
- **Cost:** a BLAKE3 per chunk, only when `verify` is given.

| # | Mutant | Result |
|---|---|---|
| V1 | The chunk check's answer ignored | killed (U5) |
| V2 | The term check skipped | killed (U5) |
| V3 | Keyed shard hashes compared plain | killed (U5) |
| V4 | Chunks before the term's first counted in its range hash | killed (U5) |

**Review of #123** found term checks matched by position: term n of the answer was taken for
term n of the shard's file, which a range request (starting mid-file) or a server that splits
terms otherwise breaks, with false alarms on correct data. Now (U6, 8 synthetic chunks, a file of
two terms):

| Finding | Fix |
|---|---|
| Terms matched by position | matched by xorb and chunk range, in order; a term with no exact match is unchecked (a range request over [4,8), a narrowed [5,8), a split [0,2)+[2,8): no false alarm) |
| A dropped or an extra term passed | `wholeFile`: the answer must be exactly the file's terms, each checked (`done`) |
| A `length` ending exactly at a term's end skipped its check | checked on that path too |
| An unknown chunk passed silently: a chunk past what the shard lists, an upper-case name | past a listed xorb's end fails; names lower-cased; `strict` fails an unlisted xorb |
| Keyed hashes without the key fell back to plain | refused |
| A short term was a plain `Error` under `verify` | an integrity failure |

A verifier walks the file's terms in order: one per reconstruction.

| # | Mutant | Result |
|---|---|---|
| X1 | Terms matched by position | killed (U6) |
| X2 | `done` ignored | killed (U6) |
| X3 | The exact-length path unchecked | killed (U6) |
| X4 | Names not lower-cased | killed (U6) |
| X5 | A chunk past the listed ones unknown | killed (U6) |
| X6 | `strict` ignored | killed (U6) |

### One fetch for several terms (U7)

A reconstruction answer lists terms and, per xorb, fetch entries (a chunk range and the byte
range holding it). Each term used to fetch its entry, so two terms of one entry fetched its bytes
twice. Now consecutive terms that resolve to the same entry, with chunk ranges going forward, are
read from one fetch: chunks between them are decoded and dropped (they are in the fetched range
anyway). Terms going backwards or repeated start a new fetch, since a stream cannot go back.
Each term is still checked (bytes, verification hash) when its last chunk is decoded.

| # | Mutant | Result |
|---|---|---|
| C1 | No grouping | killed (U7) |
| C2 | Terms going backwards grouped | killed (U7) |
| C3 | Terms of another fetch entry grouped | killed (U7) |
| C4 | A grouped term checked only at the group's end | killed (U7) |

### X11c: the live services (`src/cas.ts`)

A portable client (only `fetch`, no `node:` imports):

- **`hubPathInfo`** asks the Hub's `paths-info` for a file's Xet hash and SHA-256. The `resolve`
  endpoint also gives them (`x-xet-hash`, `x-linked-etag`, a `link` header naming the token and
  reconstruction URLs), but in a redirect a browser cannot read.
- **`xetReadToken`** gets a CAS read token: anonymous for public repositories, a Hub token for
  private ones.
- **`fetchReconstruction`** gets the answer, v1 or v2 (`xorbs[].ranges[]`, turned into v1's fetch
  entries by `v2ToV1`), for the whole file or a byte range. A range comes back narrowed to the
  terms covering it: `bytes=0-1000` gave one term of one chunk.
- **`httpRanges`** reads signed xorb URLs (no token) with `Range`. Retries and resume are
  described in U8.
- **`downloadXetFile`** chains these into `reconstruct`, with `verify` from a shard.

Live (U9, run here, not in CI): the reference CSV through every step, both answer versions,
checked against the verification shard; the CDN served the same bytes as the dataset's xorb
file.

| # | Mutant | Result |
|---|---|---|
| M1 | Resumed from the range's start | killed (U8) |
| M2 | 5xx not tried again | killed (U8) |
| M3 | `Content-Range` not checked | killed (U8) |
| M4 | v2's chunks and bytes swapped | killed (U8) |
| M5 | A 404 tried again | killed (U8) |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/xet.ts`, `src/gear-table.ts` | **Adopt** | the specification's reference data, bit for bit |
| `src/lz4.ts` | **Adopt** for Xet chunks | small, dependency-free; frames verified through chunk hashes, and against lz4_flex in both directions |
| `src/shard.ts` | **Adopt** | the reference shards, byte for byte |
| `src/cas.ts` | **Adapt** | the live services, read side; token and URL refresh for long downloads to come |

## Open threads

1. Upload: ~~xorb and shard writing, deduplication against shards~~ — answered by X11b (U1–U3);
   the CAS upload API (tokens, the xorb and shard POSTs, the global-dedupe query) is not called:
   no write token here.
2. ~~Fetching several terms of one xorb with one request~~ — answered (U7): consecutive terms of
   one fetch entry going forward share one fetch.
3. ~~Reconstruction against the live CAS~~ — answered by X11c (U8, U9): read tokens, v1 and v2
   answers, signed URLs, retries and `Range` resume. Not done: refreshing a token or a signed
   URL that expires during a long download (a new reconstruction answer would be needed).
4. ~~Verifying a fetched xorb range by its chunk hashes as it streams~~ — answered (U5):
   `reconstruct`'s `verify`, from a shard (`verifierFromShard`).

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
