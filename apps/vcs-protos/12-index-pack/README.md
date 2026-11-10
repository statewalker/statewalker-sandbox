# 12 — Can a pure-TS index-pack install real git packs byte-identically, in bounded memory, everywhere?

Plan id **X6** ("Streaming, resumable pack ingest/export"), first slice **X6a: index-pack**.
Status: **in progress.**

## Question

Clones and fetches deliver objects as a pack. git keeps the pack and writes an `.idx` next to it
(`git index-pack`): object ids (deltas resolved), CRC-32 per entry, offsets, the pack checksum.
webrun-vcs today explodes packs into loose objects through buffers. Can a pure-TypeScript
index-pack over FilesApi

- produce `.idx` v2 files **byte-identical** to `git index-pack` for real packs (OFS_DELTA and
  REF_DELTA, deep chains, a large blob),
- install the pack the way git does (temporary files, pack renamed first, idx last — a pack without
  idx is invisible to readers), so that native git reads the installed objects,
- refuse corrupt packs (truncated, bad trailer, broken zlib, out-of-range or missing delta bases)
  leaving nothing installed (quarantine), and
- keep memory bounded by the delta chain being resolved, not by the pack size,

on Node, in Chromium and in a Durable Object?

## Reject condition

Rejected if any `.idx` differs from git's for the same pack, native git cannot read an installed
pack, a corrupt pack leaves any file behind or installs a pack, or indexing a pack of large
incompressible objects needs memory proportional to the pack.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For packs made by native git from a repository with history (≥ 300 objects, deltas): with OFS_DELTA (`--delta-base-offset`), with REF_DELTA (without), after `gc --aggressive` (deep chains), and a pack holding a 4 MiB incompressible blob, our `.idx` equals `git index-pack`'s byte for byte, and our object ids, offsets and CRCs equal `git verify-pack -v`'s. |
| R2 | A pack installed by us into an empty repository's `objects/pack/`: `git verify-pack`, `git fsck --full` and `git cat-file` of every object succeed. |
| R3 | Corrupt input — truncated, last byte of the trailer flipped, a byte inside a compressed entry flipped, an OFS_DELTA base offset pointing outside the pack, a REF_DELTA base absent (thin pack, not supported here), extra bytes after the trailer — is refused and leaves no file under `objects/pack/` (no pack, no idx, no temporary). |
| R4 | Memory: indexing a pack of 64 incompressible 1 MiB blobs (64 MiB) holds < 16 MiB live (heap + array buffers), sampled inside the reads. |
| R5 | Runtimes: a committed fixture pack is indexed byte-identically to git's committed `.idx` in Chromium (OPFS) and in a Durable Object (SqliteFilesApi). |
| R6 | Delta application refuses malformed deltas (base size mismatch, copy beyond the base, result size mismatch, truncated instructions, instruction 0) instead of reading out of bounds. |

## Scope — what this slice does NOT do

- Thin packs (`--fix-thin`: appending local bases) — X6b.
- Resumable, time-sliced indexing for Durable Objects — X6b.
- Exploding packs into SQL with batched transactions — X6b.
- Pack export / pack-objects — X6c. No `.rev` files (git writes them by default since 2.31;
  they are optional caches).
