# 37 — Can webrun-vcs chunk, hash and reconstruct Hugging Face Xet files exactly?

Plan id **X11** (Hugging Face Xet). Status: **open**.

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
| H3 | **Reconstruction.** From the recorded reconstruction answer and the reference xorb (fetched by URL range): the rebuilt file is 63,527,244 bytes whose chunking (gear hash, 8 KiB…128 KiB, mask `0xFFFF000000000000`) gives the reference's 796 boundaries and chunk hashes, and whose file hash is the reference's. The xorb's chunk headers, LZ4 frames and footer marker are read as the specification defines them. |
| H4 | **Streaming.** Reconstruction yields chunks as it goes: peak memory stays within a few chunks plus the fetched range buffer, not the whole file. |
| H5 | **Portable.** `src/` has no `node:` imports. |

## Scope

- Download (reconstruction) only; uploading xorbs and shards is later work.
- ByteGrouping4-LZ4 (compression type 2) is decoded as xet-core defines it, but the reference xorb
  uses LZ4 only, so it is checked by a round trip, not against reference data.
