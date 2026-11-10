# 09 — Can one raw-bytes git object kernel over BlobStore give git's ids and git's loose objects on every backend?

Plan id **X4** ("Canonical git objects over BlobStore"). Status: **in progress.**

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
