# 09 — Can one raw-bytes git object kernel over BlobStore give git's ids and git's loose objects on every backend?

Plan id **X4** ("Canonical git objects over BlobStore"). Status: **answered — yes on every adapter; the seam needs one method, `putStaged` (write a temporary, rename once the id is known), and the published Node FilesApi must stream its writes.**

## Question

webrun-vcs computes commit and tree ids with FNV-1a plus zero padding on its mem/kv/sql backends
(`vcs-core/src/history/hash/object-hash.ts`), so the same commit gets a different id depending on
where it is stored, and `store()` of content with an unknown size buffers it in a `VolatileStore`
and reads it back before hashing. The plan replaces this with a **raw-bytes kernel**: objects are
`"<type> <size>\0" + content` bytes, the id is SHA-1 of those bytes, and backends never compute
ids. Can one such kernel, written against webrun-storage's `BlobStore`, store objects so that

- ids are git's SHA-1 on every backend (mem, FilesApi on mem / Node / OPFS, SqliteFilesApi on
  node:sqlite, sqlite-wasm and a Durable Object),
- the stored bytes are git loose objects (zlib), so a FilesApi rooted at `.git/objects` is a
  repository native git reads, and objects native git writes are read back,
- objects with exotic content (extra commit headers, legacy tree modes, tags without tagger) keep
  their ids,
- ids are verified (a wrong id is never stored, a corrupt object is never returned silently), and
- a 500 MB blob with a known size is stored in **one pass** over its source in bounded memory?

`BlobStore.put(id, bytes)` needs the id *before* the bytes, but a streamed object's id is known only
after its last byte. Git and JGit solve this by writing a temporary file and renaming it
(`ObjectDirectoryInserter`: `toTemp` while hashing, then `insertOneObject` renames; git:
`tmp_obj_XXXXXX` + `finalize_object_file`). Which minimal seam addition does the same here?

## Reject condition

Rejected if, for the same object, any backend yields a different id or different loose-object
bytes after inflation; if native git cannot read an object we wrote or we cannot read one it
wrote; if any corpus object changes id on a round trip; if a wrong id or a size lie is ever
stored; if the 500 MB put reads its source twice or grows the heap by more than 64 MB; or if
single-pass puts need more than one added method on the storage seam.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Corpus (21 objects constructed by hand and hashed and written by native git, including gpgsig / mergetag / encoding / unknown headers, zero-padded `040000` and `100664` tree modes, a legacy tag without tagger, a CRLF and an all-byte-values blob; ids checked against `git hash-object`): `put(type, size, content)` returns git's id, `putRaw(id, raw)` + `getRaw(id)` is byte-identical, `get(id)` returns type, size and content, and the stored bytes inflate to the raw object — on every adapter. |
| R2 | Native git interop (Node): objects we write into `.git/objects` are printed byte-identically by `git cat-file` and pass `git fsck --full`; objects git writes at `core.compression` 0, 1 and 9 are read back byte-identically. `list()` over a real `.git/objects` (with `pack/`, `info/` and `tmp_obj_*` entries) yields only object ids. |
| R3 | Integrity: `putRaw` with a wrong id, a malformed header (unknown type, no NUL, size disagreeing with the body) or `put` with a size lie rejects and leaves nothing stored (no object, no temporary). Reading a truncated object, an object with bytes after the zlib stream, an object whose header size disagrees with its body, or (with `verify`) an object whose bytes hash to another id raises an error. |
| R4 | One pass: `put("blob", 500 MB, source)` on a Node FilesApi iterates the source exactly once, grows the heap by less than 64 MB, and native git reports the size and passes `git fsck --full` for it. |
| R5 | Idempotence: storing an existing object again, and 10 concurrent puts of one object, succeed and leave exactly one object and no temporary. |
| R6 | The R1/R3/R5 contract runs unchanged in Chromium (mem, OPFS, SqliteFilesApi on sqlite-wasm) and inside a Durable Object on workerd (SqliteFilesApi on `ctx.storage.sql`). |

## Scope — what this prototype does NOT do

- No packs (X6), no delta resolution, no refs (X5), no typed commit/tree parsing.
- No new SQL blob store (X3b): SQL runs through statewalker's existing `SqliteFilesApi`.
- No SHA-256 object format; the hasher is injectable but only SHA-1 is exercised.

## Answer

**Yes**, with two conditions:
- **One seam addition**, `putStaged`.
- **FilesApi writes must stream.** The published `NodeFilesApi` collects every chunk before writing, so it is not bounded.

The kernel (`src/git-objects.ts`) works as follows:
- **Format.** An object is the bytes `"<type> <size>\0" + content`, its id is SHA-1 of those bytes, and it is stored as their zlib stream, which is a git loose object.
- **Identical results everywhere.** Every adapter gives git's ids for all 21 corpus objects and git's loose-object bytes. The adapters are:
  - mem;
  - FilesApi on mem, Node and OPFS;
  - SqliteFilesApi on node:sqlite, on sqlite-wasm in Chromium, and on `ctx.storage.sql` in a workerd Durable Object.
- **Native git interop.** A FilesApi rooted at `.git/objects` *is* that repository's object database: `git cat-file` and `git fsck --full` accept what we write, and we read what git writes at any `core.compression`.
- **Exotic objects keep their ids.** The kernel never parses commits or trees, so these keep their ids by construction: signed commits, `mergetag`, `encoding`, unknown headers, zero-padded or `100664` modes, tags without a tagger.
- **Large writes in one pass.** A 500 MB blob of incompressible data goes through in one pass over the source, with live heap + array buffers peaking at +4 MB (with a streaming Node FilesApi).
- **Bounded reads.** While the first chunk of a 256 MB object is held, the open read retains +1.3 MB.

Findings that shape the real implementation:

1. **One seam method: `putStaged(bytes, idOf)`.** `BlobStore.put(id, …)` needs the id first, and a streamed object's id exists only after its last byte.
   - **FilesApi:** writes `<root>/tmp_obj_*`, then `FilesApi.move` once `idOf()` is known. This is git's `finalize_object_file` and JGit's `ObjectDirectoryInserter`.
   - **An existing object is kept** (checked before the move), as in git.
   - **Concurrent writers.** Two writers racing on a *new* id both rename, and the last one wins:
     - every FilesApi `move` overwrites (Node `rename`, SqliteFilesApi, MemFilesApi, OPFS);
     - JGit has the same check-then-rename;
     - git avoids it with `link()` + `EEXIST`.

     So `stored` is advisory. The contents are identical, and each rename is atomic on Node and SqliteFilesApi.
   - **Where temporaries go.** They sit at the top of the store, as with JGit's `noz*.tmp`. git creates its own in the fan-out directory, and `git prune` removes both.
   - **Crash cleanup.** Stores git never touches (OPFS, SQLite, DO) need `sweepStaged(olderThanMs)`, which removes temporaries older than a given age at both levels.
   - **`withStaging` (stores without a rename).** The stream goes to a temporary key and is then copied. It is safe only where `put` is all-or-nothing (memBlobStore).
2. **webrun-files-node's `NodeFilesApi.write` buffers the whole file** (0.10.3 joins all chunks before `fs.writeFile`; MemFilesApi keeps the bytes anyway).
   - Trap test: a 160 MB put peaks at +320 MB.
   - `src/node-streaming-files.ts` is the 30-line fix that writes each chunk through a file handle, for upstream.
3. **Reads must bound each inflate step.** The pooled inflater (X1d) inflates a whole input chunk per push, and SqliteFilesApi returns 1 MiB blocks. A 1 MiB block of a 256 MB zero blob retained +257 MB before the first byte was returned.
   - The kernel feeds the inflater in 1 KiB slices. zlib expands at most ~1032:1, so one step yields at most about 1 MiB.
   - Content from `get` is single-use: consume it or call `return()` to release the read and the inflater.
4. **The kernel compresses, not the store.** zlib in the kernel makes the stored bytes the same on every backend, which native git needs. So SqliteFilesApi must be opened with `compression: null`, or it compresses the zlib stream again.
5. **`filesBlobStore.list()` is not an object listing.** On a real `.git/objects` it yields `pack/…`, `info/…` and `tmp_obj_*` entries as if they were ids (it strips the first `/`). The kernel filters to 40-hex ids, and every kernel method validates ids: `has("../config")` used to reach `.git/config`.
6. **`BlobStore.put(…, { verify })` buffers the whole blob** (`files-blob-store.ts`; memBlobStore always buffers), so it cannot be used for large objects. The kernel verifies while streaming and stores nothing on mismatch.
7. **Throughput depends on the data.**
   - Incompressible data, end to end: 22–25 MB/s (18 MB/s with the test's forced GCs every 50 ms).
   - Highly compressible data: 100 MB/s.
   - Bottleneck on incompressible data: deflate at zlib's default level, which is also git's (`CompressionStream` 31 MB/s, `zlib` level 1 44 MB/s).
   - SHA-1 next: noble 224 MB/s, node:crypto 1469 MB/s (injectable as `newHasher`).
   - `CompressionStream` has no level, so `core.compression` / `core.looseCompression` cannot be honoured.
   - Large binaries are LFS's job (X10) in any case.
8. **`git fsck` treats one shape as an error.** `Name<a@b>` (no space before the email) is an error by default (`missingSpaceBeforeEmail`). Such commits occur in imported histories; the corpus object is hand-made. The kernel stores and returns it unchanged, and the interop test downgrades that one message with git's `fsck.<msg-id>=warn`. That does not hide hash or zlib problems.

## Verified

All 16 Node tests and 3 Chromium tests pass (`pnpm test 09-git-objects`). The contract has 20 cases and runs on every adapter.

| # | Result |
|---|---|
| R1 | 21 corpus objects, each id equal to `git hash-object --literally` of its bytes. On every adapter: `put(type, size, content)` in 7-byte chunks returns git's id, `putRaw` + `getRaw` is byte-identical, `get(…, { verify })` returns type, size and content, and the stored bytes inflate (platform `DecompressionStream`) to the raw object at exactly the expected ids. |
| R2 | `git cat-file` prints our objects byte-identically, and `git fsck --full` exits 0 with no hash or zlib messages. Objects git writes at `core.compression` 0, 1 and 9 read back byte-identically and verify. `list()` over `.git/objects` with `pack/`, `info/packs`, a top-level and a fan-out `tmp_obj_*` yields only the object ids. |
| R3 | Rejects with `CorruptObjectError`, storing nothing (no object, no temporary):<br>• a wrong id;<br>• malformed headers, each under its *real* SHA-1 so that only header validation can reject it: `blub 3`, `blob 3abc`, `blob 4`/`blob 2` for 3 bytes, `blob 03`, `blob -1`, `blob`, an empty object;<br>• a size lie in either direction.<br>Reads raise `CorruptObjectError` for: a truncated stream, bytes after the stream, a header size that disagrees with the body, non-zlib bytes, an unknown type, a 0-byte file, a zlib stream of nothing.<br>`verify` raises `ObjectIdMismatchError` for a valid object under another id. Ids that are not 40 lowercase hex are refused by `has`, `get`, `getRaw` and `putRaw` (`InvalidObjectIdError`). |
| R4 | 500 MB of incompressible (xorshift) data through `StreamingNodeFilesApi`: the source is iterated once, and live memory is sampled (full GC, then a reading) every 50 ms and after the put. Live heap + array buffers peak at +4 MB; the put takes 28 s with those GCs (18 MB/s; 22–25 MB/s without). Garbage-inclusive readings varied by Node version (+36 MB on Node 22, +70 MB on Node 24 in CI), which is why the test forces a GC before each reading. `git cat-file -s` gives 524288000, `git fsck --full` is clean, and no temporary remains. Trap: the published `NodeFilesApi` holds +322 MB live for 160 MB. Read: holding the first chunk of a 256 MB object retains +1.3 MB. |
| R5 | Re-putting an object and 10 concurrent puts leave exactly one object and no temporary, on every adapter. An object git wrote at `core.compression=0` is left byte-for-byte when we put it again. When a store fails mid-put, the kernel closes the source (no dangling pump). `sweepStaged` removes only stale temporaries, at both levels. |
| R6 | The same 20-case contract passes in Chromium (memBlobStore, BrowserFilesApi on OPFS, SqliteFilesApi on in-memory sqlite-wasm) and inside a SQLite-backed Durable Object on workerd. |

### Mutation check

The review found one mutation that survived the first test set: header validation weakened while the contract still reported 13/13. The tests were strengthened, and every mutation below was re-run against the final tests.

| Mutation | Caught by |
|---|---|
| M1 id hashed without the `type size\0` header | contract on all adapters, R2, R4, R5 (9 tests) |
| M2 `putRaw` skips the id comparison | wrong-id case (5 tests) |
| M3 bytes after the zlib stream ignored | trailing-bytes case (5 tests) |
| M4 a body shorter than its header accepted | header-size and size-lie cases (5 tests) |
| M5 / M5b staging keeps the temporary on failure (FilesApi / generic) | "stores nothing" cases (4 / 1 tests) |
| M6 `list()` without the id filter | R2 listing over a real `.git/objects` |
| M7 `verify` ignored | verify case (5 tests) |
| M8 `deflate-raw` instead of zlib | contract, R2, R4 (8 tests) |
| M9 a whole stored block per inflate push | R4b read memory (+257 MB retained) |
| M10 no `cancel` when the store stops consuming | failing-store case (4 tests) |
| M11 `has` without id validation | invalid-id case (5 tests) |
| M12 an input with no chunks counts as "absent" on write | empty-stream case (5 tests) |
| M13 header accepts leading zeros and negative sizes | malformed-header case (5 tests) |
| M14 `sweepStaged` ignores age | sweep test |
| M15 `content` iterable twice | single-use case (5 tests) |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: "backends never compute ids", so `BlobStore` as it is suffices | It needs `putStaged`. Without it, a streamed object must be buffered or read twice. |
| FilesApi writes stream | The published NodeFilesApi (and MemFilesApi) collect the whole file. |
| First version of this README: "500 MB in +35 MB" | That held only because the test data compressed about 1000:1. With incompressible data, the published NodeFilesApi needs ~2× the object size; streaming writes are needed. |
| First version: "an existing object wins" | Only against a sequential writer. Concurrent writers of a new id both rename, because FilesApi `move` overwrites. |
| `filesBlobStore` rooted at `.git/objects` is the git object database | Its layout matches (`ab/cdef…`), but its `list()` reports pack, info and temporary files as ids, and it does not validate ids. |
| SQL objects can go through `SqliteFilesApi` as is | Only with `compression: null`, since the objects are zlib already. |
| `BlobStore.put(…, { verify })` is how ids get checked | It buffers the whole blob. Verification belongs in the streaming kernel. |

## Functional description

```ts
const objects = gitObjects(filesStagingStore(files, "/.git/objects"));
const id = await objects.put("blob", size, stream); // git's id; native git sees the object
const o = await objects.get(id, { verify: true });  // { type, size, content } — consume content once
```

**Writes.** `put` frames `"<type> <size>\0"` before the content. Each chunk passes a size check, updates SHA-1, and is pulled through `CompressionStream("deflate")` into `putStaged`. That call gets the id only after the last byte, so the object reaches its final name only once it is complete and correct. If the store stops consuming, the kernel cancels the compression stream, which closes the source. `putRaw` parses the header incrementally: a known type, a canonical decimal size, a NUL within 32 bytes. It requires a header, checks the body length, and compares the hash with the supplied id before the rename.

**Reads.** A read feeds X1d's pooled push inflater in 1 KiB slices. It rejects truncation and trailing bytes, applies the same header and size checks, and with `verify` re-hashes and throws at the end of the stream. Any stored file that inflates to nothing is corrupt, not absent.

**Differences from git and JGit on write, all accepted for the prototype:**
- files are 0644, not git's read-only 0444;
- no fsync (`core.fsyncObjectFiles`);
- no compression level.

## Interfaces produced

```ts
interface StagingBlobStore extends BlobStore {
  putStaged(bytes: ByteStream, idOf: () => string | Promise<string>): Promise<{ id: string; stored: boolean }>;
  sweepStaged?(olderThanMs: number): Promise<number>;
}
function filesStagingStore(files: FilesApi, root: string): StagingBlobStore; // tmp_obj_* + move
function withStaging(store: BlobStore): StagingBlobStore;                     // temporary key + copy (all-or-nothing puts only)
class StreamingNodeFilesApi extends NodeFilesApi {}                           // Node only: streaming write
function gitObjects(store: StagingBlobStore, newHasher?: () => Hasher): GitObjects;
interface GitObjects {
  put(type, size, content): Promise<string>;
  putRaw(id, raw): Promise<void>;
  getRaw(id): ByteStream;
  get(id, { verify? }): Promise<{ type, size, content } | undefined>;
  has(id): Promise<boolean>;
  list(): AsyncIterable<string>;
}
function runObjectContract(make, corpus): Promise<{ cases: number; failed: string[] }>;
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/git-objects.ts` | **Adopt** | The raw-bytes kernel that replaces `GitObjectStoreImpl` + `VolatileStore` and the FNV ids in vcs-core. It imports X1a's hasher and X1d's inflater by relative path, so it needs packaging. |
| `src/staging.ts` | **Adopt** (upstream) | `putStaged` / `sweepStaged` belong in webrun-storage's `BlobStore`; `filesStagingStore` belongs in `filesBlobStore` |
| `src/node-streaming-files.ts` | **Adopt** (upstream) | The streaming `write` for webrun-files-node |
| `src/object-contract.ts`, `fixtures/corpus.json`, `scripts/make-corpus.ts` | **Adopt** | Conformance and corpus for every object backend, in every runtime |
| `src/do-entry.ts` | **Source** | Pattern for the DO object store |

## Open threads (ranked by how much later work they would invalidate)

1. **Upstream** `putStaged`/`sweepStaged` to webrun-storage; a `filesBlobStore.list()` that reports only blobs and validates ids; streaming `write` in webrun-files-node; and a no-overwrite move (or `link`) in FilesApi if racing writers must keep the first file. X3b's SQL blob store should implement `putStaged` natively (insert under a temporary key, then one `UPDATE … SET key`).
2. **Packs (X6)** read objects through the same kernel interface. Loose objects alone do not scale to clones.
3. **Throughput.** For large incompressible blobs the deflate level dominates. A level option needs pako's deflate or a WASM zlib instead of `CompressionStream`.
4. **Hasher tier**: wire X1e's WASM SHA-1 where `node:crypto` is absent. Collision detection (SHA-1DC) is a future issue and plugs into `newHasher`.
5. **Verify-before-return for small objects.** `verify` reports a mismatch only at the end of the stream (JGit does the same for large objects).
