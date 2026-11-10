# 18 — Can a repository export the pack git expects, streaming, with backpressure and cancel?

Plan id **X6** (pack ingest/export), slice **X6c: pack export**. Status: **answered — yes: git's object set (rev-list --objects, edges included), packs git and X6b accept from both backends and a DO, streaming at +0.5 MiB for 64 MiB, pulled one object at a time, cancellable; whole objects cost 3.8× git's delta pack.**

## Question

Push and serve (and P2P sync over httpeers) need the other half of X6: given what the other side
wants and what it has, produce the objects it lacks as a pack git accepts. Over X16a's
`Repository` (git files or SQL), can we

- walk the objects as `git rev-list --objects <wants> --not <haves>` does,
- write them as a pack — streaming (memory bounded by an object, not the pack), pulled by the
  consumer (backpressure), cancellable with an `AbortSignal` within one object —
- that `git index-pack` and X6b accept, in Node and in a Durable Object,

and how large is a pack of whole objects next to git's (which reuses and computes deltas)?

## Reject condition

Rejected if git refuses the pack or the object set differs from git's, if memory grows with the
pack, if the producer runs ahead of the consumer, or if a cancel does not stop it.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For a native-git repository (files backend), the export for `wants = [HEAD]` (no haves) has exactly the objects of `git rev-list --objects HEAD`; `git index-pack` accepts it, and a repository built from it passes `git fsck --full` with the same `git log`. |
| R2 | Incremental: `wants = [HEAD]`, `haves = [HEAD~5]` gives exactly `git rev-list --objects HEAD ^HEAD~5`; a receiver holding `HEAD~5` installs it (native git and X6b) and passes `git fsck`. Annotated tags among the wants are sent with what they point at. |
| R3 | SQL backend: a repository received into `sqlRepository` exports a pack another `sqlRepository` receives; the logs are equal. |
| R4 | A 64 MiB incompressible blob is exported with < 16 MiB extra live memory. |
| R5 | Backpressure: while the consumer holds back, the producer reads at most one object ahead; an `AbortSignal` aborted mid-pack stops the export with an `AbortError` within one object, and every object stream it opened is released. |
| R6 | The pack size, next to `git pack-objects` for the same objects, is measured and recorded (whole objects, no deltas: the price of not reusing deltas yet). |
| R7 | In a Durable Object (SQL backend) the export of X6a's fixture history is accepted by native git (`index-pack`, `fsck`). |

## Scope — what this slice does NOT do

- Delta reuse or delta search (needs raw pack-entry access in X6r — X16a's open thread); thin packs
  (REF_DELTA against haves); the smart-HTTP / httpeers protocol framing (negotiation, sideband).

## Answer

**Yes.** `listObjects(repo, wants, haves)` walks as `git rev-list --objects <wants> --not
<haves>`; `writePack(repo, objects, { signal })` streams the pack; `exportPack` is both. Over
X16a's `Repository`, on git files and on SQL, in Node and in a Durable Object.

- **The walk.** Commits reachable from the wants and not from the haves (the haves' full ancestry
  is walked; a missing parent is a shallow boundary). Trees and blobs of those commits, minus the
  trees and blobs reachable from the trees of the haves **and of the edges** — uninteresting
  parents of listed commits — which is `rev-list`'s `mark_edges_uninteresting`. Without the
  edges, a side branch forked below a have and merged above it sent ten old objects git leaves
  out (found by the test written for the ancestry walk). Annotated tags among the wants are sent
  with what they name; gitlinks are skipped.
- **The writer.** A version-2 pack of whole objects (type, size, zlib), the SHA-1 over everything
  written. It is a pull generator: the next object is opened only when the consumer asks for the
  bytes after the previous one, its content streams through a deflater, and leaving early
  (return, throw, an aborted signal) releases the object being written — including one opened but
  not yet iterated (the consumer left right after its entry header: a leak the backpressure test
  found, X4 opens the read at `get`).
- **Size.** Whole objects: 332 KB for the 60-commit history whose git pack (deltas) is 88 KB —
  3.8×. Reusing deltas from existing packs (and searching for new ones) is the next export slice;
  it needs raw entry access in X6r (X16a's open thread).

## Verified

All 10 Node tests pass (`pnpm test 18-pack-export`). The tests were written first (red commit).

| # | Result |
|---|---|
| R1 | 20 commits, packed by `git gc`: our list equals `git rev-list --objects HEAD`; `git index-pack` accepts the export, `git fsck --full --strict` passes, `git log` equal. |
| R2 | `HEAD ^HEAD~5`: git's set; a native receiver holding `HEAD~5` and an X6b receiver (files backend) both install it, fsck passes, logs equal. A side branch forked below the have and merged above it: git's set (edges). An annotated tag: git's set, the tag listed. |
| R3 | A history received into one `sqlRepository`, exported, received into another: equal logs. |
| R4 | A 64 MiB incompressible blob in a pack: 67 MB exported, peak +0.5 MiB live. |
| R5 | After the header only it is open nothing more; after five chunks at most six objects were opened; leaving releases every one. An abort after ten chunks: `AbortError`, nothing opened after it, every stream released. |
| R6 | 332 294 B ours vs 87 571 B git's (3.8×). |
| R7 | A Durable Object (SQL backend) receives X6a's fixture pack and exports its history: native git installs it, fsck passes, 40 commits. |

### Mutation check

| Mutation | Caught by |
|---|---|
| K1 haves' trees not marked uninteresting | R2 |
| K2 haves' ancestry not walked | R2 side branch (first not caught: in a linear history the walk stops at the have anyway) |
| K3 tags not listed | R2 tag |
| K4 AbortSignal ignored | R5 abort |
| K5 an opened, unstarted object not released | R5 backpressure |
| K6 the pack header outside the checksum | R1 |
| K7 edges' trees not marked | R2 side branch |

## Interfaces produced

```ts
function listObjects(repo: Repository, wants: string[], haves: string[]): Promise<{ oid; type }[]>;
function writePack(repo: Repository, objects: { oid; type }[], opts?: { signal?: AbortSignal }): AsyncGenerator<Uint8Array>;
function exportPack(repo, wants, haves, opts?): AsyncGenerator<Uint8Array>;
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/export.ts` | **Adopt** | git's object walk and a streaming pack writer over any backend |
| `src/do-entry.ts` | **Source** | DO harness |

## Open threads (ranked by how much later work they would invalidate)

1. **Delta reuse** (copy packed entries, OFS_DELTA within the pack, REF_DELTA against haves for
   thin packs) and delta search: needs raw pack-entry access and an entry's base in X6r; closes the
   3.8× gap.
2. **Protocol framing**: smart-HTTP / httpeers negotiation (have/want/ACK), sideband progress —
   the transport milestone.
3. The walk holds the uninteresting set in memory (all objects of the haves' trees): fine for a
   prototype; git's bitmaps (or a reachability cache in SQL) for large repositories.
