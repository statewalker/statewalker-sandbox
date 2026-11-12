# Incremental builds: merging webrun-builder and webrun-cells

Status: exploration. Date: 2026-11-12.

Goal: one incremental build engine for the statewalker stack, used by notebook builds
(`@statewalker/notebook-build`, cellb.dev's `NotebookSite`), module builds
(`@statewalker/webrun-modules-build`) and future pipelines (search indexes, data loaders), that
runs the same way in Node, a browser tab, a Worker and a Durable Object.

Today there are two engines in `statewalker/webrun-sites`, both on `@statewalker/webrun-dataflow`'s
graph. This document compares them, lists what the consumers need, and proposes how to merge
them.

## 1. What exists

| | `webrun-builder` (`BuildEngine`) | `webrun-cells` (`CellEngine`) |
|---|---|---|
| Unit of work | a stage; per-signal URI watermarks (`updates`, `handled`) | a key: a row `(signal, key) → value` |
| State | JSON files on a `FilesApi` (`updates.json`, `transactions.json`, `scanner.json`) | five SQLite tables through `SqlDriver` (`node:sqlite`, Durable Object SQL, D1) |
| What a stage receives | URIs and stamps; it reads the content itself | the row's value |
| Change detection | built-in scanner: mtimes of a file tree, `.projectignore` | none: callers `put` and `remove` source rows |
| Deletions | a `sources-removed` tombstone signal, handled by a separate stage | retraction: rows derived from a removed row are deleted through recorded provenance, transitively |
| An output equal to the stored one | still cascades | stops the cascade (canonical JSON compared as text) |
| Failures | the builder catches, records, marks handled | retried `maxAttempts` times, then parked in a dead-letter table; the rest converges |
| Re-derivation | `restartFrom(cell)` replays everything downstream | `requeue(cell, signal, key)` for one input |
| Crash safety | checkpoint per frontier advance | each input commits atomically with its outputs; leases for concurrent engines |
| Scheduling | frontier/convergence loop; cooperative `yieldControl()` | claim, run, commit until nothing is claimable |
| Status | published 0.2.1; used by `webrun-modules-build`, `notebook-build` (so cellb's `NotebookSite`) | private 0.0.0; no consumers |

## 2. What the consumers had to work around

`notebook-build`'s own comments record the cost of `BuildEngine`'s model:

- **The only trigger is a source's mtime.** The configuration, the module server's answers,
  attachments and the output tree can all change with no source touched. `notebook-build` runs a
  `revalidate()` pass over every notebook before each build and calls `restartFrom()`, which
  replays every update downstream.
- **A `sources` entry outlives its file.** `restartFrom` replays deleted sources, so each stage
  guards with "does the file still exist?". One comment records the bug this caused: deleted
  notebooks came back as blank pages.
- **No provenance.** Pruning needs hand-written manifests (`.outputs.json`) and a separate
  `[Prune]` stage fed by tombstones; "successfully built" is a hand-written sidecar
  (`.state.json`).
- **Values travel outside the engine.** Stages hand data over through files in a cache
  (`.nb.html` artifacts) because the engine carries only URIs and stamps.

`webrun-cells` answers the last three directly: values are rows, provenance is recorded, and a
removal retracts what was derived from it. The first needs a general way to put non-file facts
into the graph, which `webrun-cells`' source signals already are.

## 3. What a merged engine needs

1. **Key-level rows with provenance, cut-off and retraction** (from `webrun-cells`).
2. **A file-tree source**: the scanner as an adapter that diffs a `FilesApi` tree against a
   `files` signal and calls `put`/`remove` (mtime and size, optionally a content hash), with
   `.projectignore`.
3. **Non-file facts as sources**: configuration, resolver answers, environment, put by the host;
   a change cascades like any other.
4. **Cell versions**: a cell declares `version`; when it changes (new code, new configuration
   hash), every input of that cell is re-queued. This replaces `restartFrom` for code changes.
5. **File outputs (sinks)**: a sink is a cell the engine also calls for retractions. A
   `FilesApi` sink writes a row's file on upsert and deletes it on retraction, so pages, modules
   and attachments are pruned without manifests.
6. **Large values out of rows**: a content-addressed blob helper over a `FilesApi`, so rows hold
   a hash and metadata, not megabytes of JavaScript.
7. **Time-boxed runs**: `run({ budgetMs, signal })` that stops between commits and reports
   whether work remains, so a Durable Object can continue from an alarm and a tab stays
   responsive (replaces `yieldControl()`).
8. **Observability**: progress events, per-cell pending counts, dead letters, requeue.
9. **Storage everywhere**: SQL through `SqlDriver` (Node, Durable Object, D1, OPFS SQLite in a
   tab), and an in-memory store for tests and quick scripts.

## 4. Options

### A. Keep both engines

- Pro: no migration; each serves its niche (file pipelines vs keyed data).
- Con: two schedulers, two state formats, two sets of docs; the consumers' workarounds stay.
  New pipelines must pick one and inherit its gaps.

### B. Extend `BuildEngine` with provenance and values

- Pro: consumers keep their API.
- Con: its state model (per-signal watermarks in JSON files) has no place for values, provenance
  or atomic per-input commits; adding them is a rewrite under the old API, and the API's
  `readUpdates`/`handled()` shape leaks the watermark model to every stage.

### C. Merge `webrun-cells` into `webrun-builder`, keyed engine as the core (recommended)

`webrun-builder` gets the keyed engine (renamed from `CellEngine`, see below) plus items 2–8 of
Section 3. `BuildEngine` stays exported and unchanged during migration, then is deprecated.
`webrun-cells` is removed.

- Pro: one published package name the consumers already depend on; the engine with the better
  model becomes the only one; the change is additive (a minor version) until `BuildEngine` is
  removed.
- Pro: SQL state lands where the platforms already have SQLite (Durable Object storage, D1,
  `node:sqlite`, cellb's OPFS SQLite).
- Con: `webrun-builder` carries two engines for a while.
- Con: consumers must be rewritten from "drain URIs, read files, write files" to "map an input row
  to output rows", which is the point, but is work: `webrun-modules-build`, `notebook-build`, and
  cellb's `NotebookSite`.

### D. A new package (`webrun-incremental`), both old ones deprecated

- Pro: a clean name and API with no legacy.
- Con: a third package during migration; consumers change their dependency as well as their code.

## 5. Recommendation

**Option C.** Concretely:

- **Names.** In `@statewalker/webrun-builder`: `IncrementalEngine` (the keyed engine), `Cell`,
  `Sink`, `filesSource()` (the scanner adapter), `filesSink()`, `blobStore()`,
  `memoryStore()`/`sqlStore(driver)`. `BuildEngine` and its scanner stay as they are, marked
  deprecated once the consumers have moved.
- **Order of work.**
  1. Move `webrun-cells`' engine, schema and tests into `webrun-builder` unchanged in behaviour;
     delete `webrun-cells`.
  2. Add the storage port with `sqlStore` (the existing SQL) and `memoryStore`.
  3. Add cell versions, sinks with retraction calls, time-boxed `run`, progress events.
  4. Add `filesSource` (mtime/size, `.projectignore`), `filesSink`, `blobStore`.
  5. Migrate `webrun-modules-build`, then `notebook-build` (statewalker-knowledge), then cellb's
     `NotebookSite` page models (the engine in the object's SQLite).
  6. Deprecate, then remove, `BuildEngine`.
- **What a notebook build looks like after.** `files` (source rows from the scanner) →
  `[Parse]` → `notebook` rows (the Portable Text document) → `[Resolve]` (reads the `config`
  and module-server facts) → `pins` rows → `[Compile]` → `page-model` rows → `[Render]` sink
  writing pages. Deleting a notebook retracts its document, pins, model and page; a new resolver
  answer re-runs only `[Resolve]` onward for the notebooks whose pins changed.

## 6. Open questions

- Does `SqlDriver`'s "no read inside a transaction" rule (for D1) hold for every feature above?
  Retraction already works within it; sinks need an outbox (`cells_effects`) so a file write
  follows a committed row and is retried after a crash.
- Does an in-memory store need persistence (a snapshot to a `FilesApi`) for tabs without SQLite,
  or is cellb's OPFS SQLite enough there?
- Should the scanner hash content (stable across `git checkout`, costs a read per file) or rely on
  mtime and size (cheap, what `BuildEngine` does)? Probably mtime and size, with hashing on demand.
- Where does the module server's own cache fit: a source of facts (pins) or a cell? Facts first:
  a resolver answer is an external observation, like a file.
