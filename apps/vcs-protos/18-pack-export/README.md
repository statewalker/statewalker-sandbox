# 18 — Can a repository export the pack git expects, streaming, with backpressure and cancel?

Plan id **X6** (pack ingest/export), slice **X6c: pack export**. Status: **answered — yes: git's `--objects-edge-aggressive` set (never more than `rev-list --objects`, never less than what the haves lack) from a limited walk, packs git and X6b accept from both backends and a DO, streaming at ~1 MiB for 64 MiB, cancellable; whole objects cost 3.8× git's delta pack.**

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

- **The walk — commits.** git's limited walk (revision.c `limit_list`): one queue by committer
  date over both sides, uninteresting propagated to parents, stopped once only uninteresting
  commits are queued and none is as new as an interesting one found (then five more for clock
  skew). An incremental export reads the commits near the tips: 4 objects from a 400-commit
  history read < 50 objects (the first version walked the haves' whole ancestry: 3 s for 5 000
  commits — the review). git's own cut-off only counts queued commits; with **equal dates** it
  stopped too early on random histories and sent a want the have already contained — the date
  guard is why ours does not. A have this repository lacks is ignored (a receiver may claim
  anything); a missing want or parent **fails** unless below a commit declared `shallow` (the
  first version treated any missing parent as a boundary and sent a broken history — the review).
- **The walk — trees and blobs.** Those of the sent commits, minus everything reachable from the
  trees of the haves and of the **edges** (uninteresting parents of sent commits). That is git's
  `rev-list --objects-edge-aggressive` set: plain `rev-list --objects` marks only the edges' trees
  and sends objects the receiver already has in the haves' trees (the first README said "exactly
  rev-list": the review measured 28 of 150 random queries differ, always by git sending more).
  Without the edges, a side branch forked below a have and merged above it sent ten old objects.
  Trees, blobs and tags given as haves are uninteresting themselves (the first version ignored
  them); annotated tags among the wants are sent with what they name; gitlinks are skipped. The
  list carries each tree's and blob's path (rev-list's), and `listObjectsWithEdges` returns the
  edges — what delta search and thin packs need next.
- **The writer.** A version-2 pack of whole objects (type, size, zlib), the SHA-1 over everything
  written. It is a pull generator: the next object is opened only when the consumer asks for the
  bytes after the previous one, its content streams through a deflater, and leaving early
  (return, throw, an aborted signal) releases the object being written — including one opened but
  not yet iterated (the consumer left right after its entry header: a leak the backpressure test
  found, X4 opens the read at `get`). For compressible data the deflater may read a whole small
  object before its first output, so "one object ahead" means up to one object read in advance.
  An aborted signal throws its reason (an AbortError unless the caller aborts with another value),
  in the walk as well as while writing. The list is fixed before writing: a gc that removes a
  listed object fails the export mid-stream. A fresh deflater per object costs ~0.1 ms (20 000
  small objects: 2 s) — delta reuse that copies compressed entries removes most of it.
- **Size.** Whole objects: 332 KB for the 60-commit history whose git pack (deltas) is 88 KB —
  3.8×. Reusing deltas from existing packs (and searching for new ones) is the next export slice;
  it needs raw entry access in X6r (X16a's open thread).

## Verified

All 18 Node tests pass (`pnpm test 18-pack-export`). The tests were written first (red commits,
the review's too).

| # | Result |
|---|---|
| R1 | 20 commits, packed by `git gc`: our list equals `git rev-list --objects HEAD`; `git index-pack` accepts the export, `git fsck --full --strict` passes, `git log` equal. |
| R2 | `HEAD ^HEAD~5`: git's set; a native receiver holding `HEAD~5` and an X6b receiver (files backend) both install it, fsck passes, logs equal. A side branch forked below the have and merged above it: git's set (edges). An annotated tag: git's set, the tag listed. |
| R3 | A history received into one `sqlRepository`, exported, received into another: equal logs. |
| R4 | A 64 MiB incompressible blob in a pack: 67 MB exported, peak +0.5–1.0 MiB live. Streaming, not buffering, on both backends: stopping after the first deflated chunk of an 8 MiB object had read ≤ 2 MiB of it (files and SQL). |
| R5 | After the header only it is open nothing more; after five chunks at most six objects were opened; leaving releases every one. An abort after ten chunks: `AbortError`, nothing opened after it, every stream released. |
| R6 | 332 294 B ours vs 87 571 B git's (3.8×). |
| R7 | A Durable Object (SQL backend) receives X6a's fixture pack and exports its history: native git installs it, fsck passes, 40 commits. (The harness buffers the pack into one response: streaming in workerd is the transport milestone's.) |
| Review | Random histories (branches, merges, criss-cross, shared files; 6 × 6 queries): every set ⊆ `rev-list --objects`, ⊇ closure(wants) \ closure(haves), and = `--objects-edge-aggressive` unless the want is below the have; a blob in the have's tree but not the fork point's is not sent; tree, blob and tag haves; a missing commit fails, a declared shallow commit bounds the walk; 400 commits, `HEAD ^HEAD~1` read < 50 objects; an abort during the walk; paths equal rev-list's, edges returned. |

### Mutation check

| Mutation | Caught by |
|---|---|
| K1 haves' trees not marked uninteresting | R2 |
| K2 haves' ancestry not walked | R2 side branch (first not caught: in a linear history the walk stops at the have anyway) |
| K3 tags not listed | R2 tag |
| K4 AbortSignal ignored | R5 abort |
| K5 an opened, unstarted object not released | R5 backpressure |
| K6 the pack header outside the checksum | R1 |
| K7 edges' trees not marked | R2 side branch, random histories |
| K1′ have tips' trees not marked (plain rev-list) | "a blob the have's tree holds" (the random histories missed it: the shape is rare) |
| N1 tree haves ignored / N2 tag haves not uninteresting | non-commit haves |
| N3 a missing parent taken as a boundary | missing object |
| N4 the walk never stops early | 400-commit incremental (reads) |
| N5 git's plain cut-off without the date guard | random histories (equal dates) |
| N6 paths not recorded / N7 edges not returned | paths and edges |

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

1. **Delta reuse** (copy packed entries, OFS_DELTA within the pack, REF_DELTA against the edges'
   objects for thin packs) and delta search (sorted by type, path hash, size — the paths are
   there): needs raw pack-entry access and an entry's base in X6r; closes the 3.8× gap and most of
   the per-object deflate cost.
2. **Protocol framing**: smart-HTTP / httpeers negotiation (have/want/ACK), sideband progress —
   the transport milestone.
3. The walk holds the uninteresting objects of the haves' and edges' trees in memory: fine for a
   prototype; git's bitmaps (or a reachability cache in SQL) for large repositories. Generation
   numbers (commit-graph) would let the cut-off stop early also on equal dates.
