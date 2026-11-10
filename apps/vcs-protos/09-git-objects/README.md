# 09 — Can one raw-bytes git object kernel over BlobStore give git's ids and git's loose objects on every backend?

Plan id **X4** ("Canonical git objects over BlobStore"). Status: **answered — yes on every adapter; the seam needs one method, `putStaged` (write a temporary, rename once the id is known).**

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
| R1 | Corpus (21 objects made by native git, including gpgsig / mergetag / encoding / unknown headers, zero-padded `040000` and `100664` tree modes, a legacy tag without tagger, a CRLF and an all-byte-values blob; ids checked against `git hash-object`): `put(type, size, content)` returns git's id, `putRaw(id, raw)` + `getRaw(id)` is byte-identical, `get(id)` returns type, size and content, and the stored bytes inflate to the raw object — on every adapter. |
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

**Yes.** A kernel of about 250 lines (`src/git-objects.ts`) works on every adapter:
- An object is the bytes `"<type> <size>\0" + content`, its id is SHA-1 of those bytes, and it is stored as their zlib stream, which is a git loose object.
- It runs over webrun-storage's `BlobStore` plus **one added method**.
- Every adapter gives git's ids for all 21 corpus objects, and the stored bytes are git's loose-object format. The adapters are:
  - mem;
  - FilesApi on mem, Node and OPFS;
  - SqliteFilesApi on node:sqlite, on sqlite-wasm in Chromium, and on `ctx.storage.sql` inside a workerd Durable Object.
- A Node FilesApi rooted at a repository's `.git/objects` *is* that repository's object database: `git cat-file` and `git fsck --full` accept what we write, and we read what git writes at any `core.compression`.
- The kernel never parses commits or trees. So signed commits, `mergetag`, `encoding`, unknown headers, zero-padded or `100664` modes and legacy tags keep their ids by construction.
- A 500 MB blob is stored in one pass over its source at 101 MB/s, with a memory peak of +35 MB.

Findings that shape the real implementation:

1. **One seam method: `putStaged(bytes, idOf)`.** `BlobStore.put(id, …)` needs the id first, and a streamed object's id exists only after its last byte. So `put` alone forces either buffering (today's `VolatileStore`) or two passes over the source.
   - **FilesApi:** `putStaged` writes `<root>/tmp_obj_*` and calls `FilesApi.move` once `idOf()` is known. This is git's `finalize_object_file` and JGit's `ObjectDirectoryInserter`.
     - The move is metadata-only on Node, MemFilesApi and SqliteFilesApi.
     - The temporary name is git's own, so `git gc` / `git prune` clean up any left by a crash.
     - If the target already exists, the existing object wins, as in git.
   - **Other stores (`withStaging`):** with no rename, the bytes go to a temporary key and are copied. That is still one pass over the source but two over storage. It is a fallback, not the target.
2. **The kernel compresses, not the store.** zlib in the kernel makes the stored bytes identical in kind on every backend, which is exactly what native git needs. So SqliteFilesApi must be opened with `compression: null`: its default codec would compress the zlib stream again.
3. **`filesBlobStore.list()` is not an object listing.** On a real `.git/objects` it yields `pack/…`, `info/…` and `tmp_obj_*` entries as if they were ids (it strips the first `/`). The kernel filters to 40-hex ids. An object database over FilesApi must own its listing.
4. **`BlobStore.put(…, { verify })` buffers the whole blob** (`files-blob-store.ts`, `mem.ts` collect every chunk before writing), so it cannot be used for large objects. The kernel verifies while streaming and puts nothing on mismatch.
5. **SHA-1 is the bottleneck.** On Node, noble SHA-1 runs at 224 MB/s, node:crypto at 1469 MB/s, and `CompressionStream("deflate")` at 302 MB/s on this data. The kernel takes its hasher as a parameter (`gitObjects(store, newHasher)`), so the X1e WASM tier or node:crypto plugs in without changes.
6. **`git fsck` rejects one real-world shape.** It calls `Name<a@b>` (no space before the email) an *error* (`missingSpaceBeforeEmail`). Old repositories contain such commits. The kernel stores and returns them unchanged, and the interop test downgrades that message with git's own `fsck.<msg-id>=warn`.

## Verified

All 12 Node tests and 3 Chromium tests pass (`pnpm test 09-git-objects`). The contract has 13 cases and runs on every adapter.

| # | Result |
|---|---|
| R1 | The corpus has 21 objects, and every id equals `git hash-object --literally`. On every adapter: `put(type, size, content)` in 7-byte chunks returns git's id, `putRaw` + `getRaw` is byte-identical, `get(…, { verify })` returns type, size and content, and the stored bytes inflate (with the platform's `DecompressionStream`) to the raw object at exactly the expected ids. |
| R2 | `git cat-file -t` and `git cat-file <type>` print our objects byte-identically. `git fsck --full` exits 0 with no hash or corruption messages. Objects git writes at `core.compression` 0, 1 and 9 are read back byte-identically and verify. `list()` over `.git/objects` with `pack/`, `info/packs` and `tmp_obj_*` yields only the 5 object ids. |
| R3 | These rejects leave nothing stored (no object, no `tmp_obj_*`): a wrong id; the headers `blub 3`, `blob 3abc` (no NUL), `blob 4` / `blob 2` for 3 bytes, `blob 03` and `blob -1`; a size lie in either direction. Reads raise on a truncated zlib stream, bytes after the stream, a header size that disagrees with the body, and non-zlib bytes. `verify` raises `ObjectIdMismatchError` for a valid object stored under another id. |
| R4 | 500 MB on NodeFilesApi: the source is iterated once (500 MB pulled), heap + array buffers peak at +35 MB, 4.9 s (101 MB/s). `git cat-file -s` reports 524288000, `git fsck --full` is clean, and no temporary is left. |
| R5 | Re-putting an object and 10 concurrent puts of it leave exactly one object and no temporary, on every adapter. |
| R6 | The same contract passes in Chromium (memBlobStore, BrowserFilesApi on OPFS, SqliteFilesApi on in-memory sqlite-wasm) and inside a SQLite-backed Durable Object on workerd (SqliteFilesApi on `newDoSqliteDb(ctx.storage)`). |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 id hashed without the `type size\0` header | R1 on all adapters, R2, R4, DO (7 tests) |
| M2 `putRaw` skips the id comparison | wrong-id case on all adapters and DO (5 tests) |
| M3 bytes after the zlib stream ignored | trailing-bytes case (5 tests) |
| M4 a body shorter than its header accepted | header-size and size-lie cases (5 tests) |
| M5 FilesApi staging keeps the temporary when the stream or id fails | "stores nothing" cases on the FilesApi adapters and DO (4 tests) |
| M5b generic staging keeps the temporary | memBlobStore contract (1 test) |
| M6 `list()` without the id filter | R2 listing over a real `.git/objects` |
| M7 `verify` ignored | verify case (5 tests) |
| M8 `deflate-raw` instead of zlib | stored-bytes case, R2 `git cat-file` / `fsck`, R4 (7 tests) |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan: "backends never compute ids", so `BlobStore` as it is suffices | It needs `putStaged`. Without it, a streamed object must be buffered or read twice. |
| `filesBlobStore` rooted at `.git/objects` is the git object database | Its layout matches (`ab/cdef…`), but its `list()` reports pack, info and temporary files as ids. |
| SQL objects can go through `SqliteFilesApi` as is | Only with `compression: null`, since the objects are zlib already. |
| `BlobStore.put(…, { verify })` is how ids get checked | It buffers the whole blob. Verification belongs in the streaming kernel. |

## Functional description

```ts
const objects = gitObjects(filesStagingStore(new NodeFilesApi({ rootDir: repo }), "/.git/objects"));
const id = await objects.put("blob", size, stream); // git's id; native git sees the object
const o = await objects.get(id, { verify: true });  // { type, size, content }
```

**Writes.** `put` frames `"<type> <size>\0"` before the content. Each chunk passes a size check, updates SHA-1, and is pulled through `CompressionStream("deflate")` into `putStaged`. That call gets the id only after the last byte, so the object reaches its final name only once complete and correct. `putRaw` parses the header incrementally (a known type, a canonical decimal size, NUL within 32 bytes), checks the body length, and compares the hash with the supplied id before the rename.

**Reads.** A read inflates with X1d's pooled push inflater. It rejects truncation and trailing bytes, applies the same header and size checks, and with `verify` re-hashes and throws at the end of the stream. `get` returns the header as soon as it has been inflated, without reading the body first.

## Interfaces produced

```ts
interface StagingBlobStore extends BlobStore {
  putStaged(bytes: ByteStream, idOf: () => string | Promise<string>): Promise<{ id: string; stored: boolean }>;
}
function filesStagingStore(files: FilesApi, root: string): StagingBlobStore; // tmp_obj_* + move
function withStaging(store: BlobStore): StagingBlobStore;                     // temporary key + copy
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
| `src/git-objects.ts` | **Adopt** | The raw-bytes kernel that replaces `GitObjectStoreImpl` + `VolatileStore` and the FNV ids in vcs-core |
| `src/staging.ts` | **Adopt** (upstream) | `putStaged` belongs in webrun-storage's `BlobStore`; `filesStagingStore` in `filesBlobStore` |
| `src/object-contract.ts`, `fixtures/corpus.json`, `scripts/make-corpus.ts` | **Adopt** | Conformance and corpus for every object backend, in every runtime |
| `src/do-entry.ts` | **Source** | Pattern for the DO object store |

## Open threads (ranked by how much later work they would invalidate)

1. **Upstream `putStaged`** into webrun-storage, together with a `filesBlobStore.list()` that reports only blobs (or an `isId` option). X3b's SQL blob store should implement `putStaged` natively (insert under a temporary key, `UPDATE` the key in one statement).
2. **Packs (X6)** read objects through the same kernel interface. Loose objects alone do not scale to clones.
3. **Hasher tier:** wire X1e's WASM SHA-1 by default where `node:crypto` is absent. Noble limits throughput to about 100 MB/s.
4. **Collision detection** (SHA-1DC), already logged as a future issue, plugs in through `newHasher`.
5. **Verify-before-return for small objects:** `verify` reports a mismatch only at the end of the stream, after the content was delivered (JGit does the same for large objects). Callers that act on content before the end must buffer small objects.
