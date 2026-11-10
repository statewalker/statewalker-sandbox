# 13 — Can objects be read from installed packs (and loose objects) as native git reads them, in bounded memory, everywhere?

Plan id **X6** (pack ingest/export), slice **X6r: reading packs**. Status: **in progress.**

## Question

X6a installs packs (`pack-<id>.pack` + `.idx`) exactly as git does, but nothing reads objects out
of them yet: after a clone, the repository is only usable through native git. Can a pure-TS object
database over FilesApi — loose objects through X4's kernel plus every installed pack — return every
object byte-identically to `git cat-file`, with

- idx lookups as git's (fan-out + binary search, large offsets), validation of idx and pack
  checksums on open,
- delta chains (OFS and REF) resolved through a byte-bounded base cache (git's `delta_base_cache`),
- large non-delta objects streamed without materialising them,
- corruption detected (bad idx checksum, pack/idx mismatch, broken entry, wrong hash with
  `verify`),

on Node, in Chromium and in a Durable Object?

## Reject condition

Rejected if any object differs from `git cat-file`'s, a corrupt idx or a pack/idx mismatch is
accepted, reading a delta-heavy pack needs memory proportional to the pack or to chain depth ×
object size beyond the cache budget, or streaming a 64 MiB packed blob holds it in memory.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For every object of packs made by native git (OFS_DELTA, REF_DELTA installed through X6a, `gc --aggressive`, a 4 MiB blob with a delta child), type, size and content equal `git cat-file --batch`. |
| R2 | An object database over a repository with objects split across loose files and two packs reads every object; an absent id returns `undefined`; `has` agrees; `list` yields every id once. |
| R3 | Opening a pack whose idx checksum is wrong, whose idx names another pack (trailer mismatch) or whose idx is truncated fails with `PackError`; reading an entry whose compressed bytes are corrupt fails with `PackError`; `verify: true` detects content that hashes to another id. |
| R4 | Reading every object of a 4 MiB base + 50-deep chain pack in random order holds < 24 MiB live with a 16 MiB base cache; with the cache, the number of entry inflations is at most half of what it is without. |
| R5 | In Chromium (OPFS) and a Durable Object (SqliteFilesApi): every object of X6a's fixture pack is read with `verify: true` (its content hashes to its id). |
| R6 | A 64 MiB incompressible blob stored in a pack without delta is streamed with < 16 MiB live. |

## Scope — what this slice does NOT do

- No multi-pack index (`multi-pack-index`), no `.rev` or bitmap files.
- No writing (X6a installs, X4 writes loose objects); no repacking or gc (X18).
