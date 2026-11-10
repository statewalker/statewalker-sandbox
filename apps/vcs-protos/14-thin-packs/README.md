# 14 — Can index-pack complete thin packs from the local repository and index 100k+ objects in a Durable Object's memory?

Plan id **X6** (pack ingest/export), slice **X6b1: thin packs, compact entries, bounded reads,
temporaries**. Status: **open**.

## Question

X6a's `installPack` refuses thin packs — the packs every `git fetch` receives, whose REF_DELTA
bases are objects the receiver already has (`git pack-objects --thin`). It also holds about 0.9 KB
of heap per entry (+170 MiB for 200 000 objects: too much for a 128 MiB Durable Object), reads each
delta back with its own storage read, and never removes the `tmp_*` files an interrupted install
leaves behind. Can index-pack, as git's `index-pack --fix-thin`,

- resolve the missing bases from the local object database (X6r), append them to the pack as
  whole objects, rewrite the header count and the trailer, and install the completed pack,
- keep its per-entry state in typed arrays, so 200 000 objects fit in a few tens of MiB,
- serve phase-2 reads from a bounded window over the stored pack instead of one read per delta,
- sweep stale temporaries as `git prune` does,

without giving up anything X6a verified (git-identical `.idx`, refusals of hostile packs)?

## Reject condition

Rejected if a completed thin pack holds other objects than git's `index-pack --fix-thin` makes of
it or fails `git verify-pack` / `git fsck`, if a base whose content does not hash to the requested
id is accepted, if any of X6a's native-git packs no longer indexes to git's `.idx`, or if 200 000
entries still need memory of the order of X6a's.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Thin packs made by `git pack-objects --thin` (REF_DELTA and `--delta-base-offset`; an incremental range of a history repository; a 4 MiB blob edited by one byte), installed with `externalBase` reading the receiver's object database (X6r): the installed pack holds exactly the objects of `git index-pack --fix-thin`'s, appended bases in git's order with git's types; the entries of the received pack keep their offsets and CRC-32 as in git's index; the pack is named after the SHA-1 of its final content, passes `git verify-pack` and `git fsck --full`, and `git cat-file` reads every object. |
| R1b | A thin pack is refused with `PackError` and nothing installed when no `externalBase` is given (X6a's behaviour), when a base is unknown (the message counts the unresolved deltas), or when `externalBase` returns content that hashes to another id. A REF_DELTA whose base is itself the result of a thin delta resolves without another lookup; a base wanted by several deltas is appended once. |
| R2 | Every X6a native-git pack (OFS, REF, `gc --aggressive`, 4 MiB blob with a delta child) still indexes to an `.idx` byte-identical to `git index-pack`'s; hostile packs are still refused (X6a's R3/R3b cases re-run against this implementation). |
| R3 | A 200 000-object pack (with OFS and REF deltas) installs with < 40 MiB extra live memory (heap + array buffers, sampled after GC on every storage read) and an `.idx` identical to git's. |
| R4 | A pack header that declares more entries than the pack's size can hold is refused before anything is allocated. |
| R5 | Phase 2 reads the stored pack through a bounded window: for the 60-commit history pack (≥ 300 deltas) the number of storage reads is at most a quarter of the number of delta loads. |
| R6 | `sweepPackTemporaries(files, packDir, { olderThanMs })` removes `tmp_*` files in the pack directory older than the threshold (git prune's rule), keeps younger ones and never touches `pack-*` files. |
| R7 | In Chromium (OPFS) and a Durable Object (SqliteFilesApi) a committed thin-pack fixture is completed from committed base objects to the same pack and `.idx` as on Node. |

## Scope — what this slice does NOT do

- Resumable, time-sliced indexing across Durable Object requests — X6b2.
- Exploding packs into the native SQL store — X6b3.
- `check_collision` against objects already present and SHA-1 collision detection.
