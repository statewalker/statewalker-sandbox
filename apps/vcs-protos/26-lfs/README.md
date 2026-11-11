# 26 — Can Git LFS run on our stores, both ways with native git-lfs, verified, resumable, in bounded memory?

Plan id **X10** (LFS), slice **X10a: pointers, store, batch API, basic transfer**. Status: **answered — yes, verified against native git-lfs; Gitea left open**.

## Question

Large files are what git's object store is worst at: git-lfs replaces them in the tree by a small
pointer and moves the content over the LFS Batch API. X12 (large files between peers) needs that
layer first. Can the following work, portable (no `node:` imports: browser, Node, Durable
Objects)?
- pointers byte-identical to git-lfs, and its clean and smudge;
- an object store on any FilesApi in git-lfs's own layout;
- the Batch API and basic transfer, both as a server (a fetch handler next to X8's git handler)
  and as a client;
- native `git push` and `git clone` with git-lfs against our server;
- every byte verified before an object becomes visible;
- downloads resumed with HTTP Range;
- memory bounded whatever the file size.

## Reject condition

Rejected if any of these happens:
- a pointer or a clean result differs from git-lfs's;
- native git-lfs cannot push to or clone from our server;
- an object whose bytes do not hash to its id becomes visible;
- an interrupted download starts again from zero;
- memory grows with the object's size.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | **Pointers and filters.** `encodePointer` is byte-identical to `git lfs pointer --file` (empty, 1 byte, text, binary, multi-MiB), and an empty file is its own pointer. `parsePointer` accepts what git-lfs accepts (the `version` line first, keys in order, `oid sha256:<64 hex>`, decimal `size`, extension lines, at most 1024 bytes) and refuses the rest. `clean` equals `git lfs clean`. `smudge` of a pointer gives the content, and of a non-pointer gives the input unchanged, as `git lfs smudge` does. |
| R2 | **Store.** Objects live at git-lfs's layout, `lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`, under the repository root, so native git-lfs in a git-files repository finds what we store (`git lfs fsck` clean) and we find what it stored. `put` streams into a temporary file, checks SHA-256 and size, then renames. A mismatch is refused and leaves nothing visible. It works on the git-files and the SQL repository. |
| R3 | **Server.** The Batch API (`POST …/info/lfs/objects/batch`, `application/vnd.git-lfs+json`): download and upload, the `basic` transfer, actions with `href` and `header`, per-object errors (404 missing, 422 invalid oid or size). Basic transfer: `PUT` verified as in R2, `GET` with `Range` (206; 416 when out of range), and the `verify` action. It is served next to X8's git handler at one URL. Native `git push` with git-lfs stores the objects (verified), and native `git clone` smudges files byte-identical to the originals. |
| R4 | **Client.** `lfsPush` and `lfsFetch` speak the Batch API and basic transfer. Objects the server already has are not sent. What our client pushed, native git-lfs clones identically; what native git-lfs pushed, our client fetches identically. A commit made with the façade (X16b) holding a pointer and `.gitattributes`, pushed with git and LFS, clones natively with the file smudged. |
| R5 | **Resume and verify.** A download cut part-way leaves its bytes in `lfs/incomplete/`, and the next fetch asks only for the rest (`Range: bytes=N-`); the transferred bytes are counted. A server answering 200 instead of 206 restarts cleanly. Bytes that do not hash to the oid, or have the wrong size, are refused, and nothing stays visible or partial. |
| R6 | **Bounded memory.** A 256 MiB object goes through clean, store, upload, download and smudge with heap growth under 32 MiB. 2 GB in the plan is scaled down for CI; the code has no size-dependent buffer. |
| R7 | **Access.** An `authorize(request, operation)` hook decides download and upload per batch: 401 without credentials, 403 for a reader uploading, as git-lfs expects. Transfer requests carry the action's headers, which a server can scope to the object. |
| R8 | **Durable Object.** In workerd (Miniflare) the store over the SQL repository's files plus the server answer a batch, an upload and a ranged download. |

## Scope — what this slice does NOT do

- **Gitea as a second oracle** (the plan's "Gitea-verified"). Docker has no daemon in this
  environment, and running a downloaded Gitea binary was not permitted in this session. git-lfs
  itself is the reference client here; Gitea is left as an open thread.
- The locking API (git-lfs is run with `lfs.locksverify=false`), transfer adapters other than
  `basic` (tus, multipart, ssh), Xet (X11), and P2P (X12, next).

## Answer

Yes. native git-lfs 3.4 was the oracle throughout, as `pointer`, `clean`, `smudge`, `push`,
`clone` and `fsck`. Four modules, with no `node:` imports, cover the whole path.

| # | Result | How |
|---|---|---|
| R1 | ✅ | `encodePointer` and `clean` are byte-identical to `git lfs pointer` and `git lfs clean` (empty to 3 MiB); an empty file is its own empty pointer. `parsePointer` follows git-lfs's `DecodeFrom`: it reads the first 1024 bytes (a BOM kept, so refused), trimmed as Go's `TrimSpace` trims (NEL and the Unicode spaces too); skips blank lines; accepts CRLF; needs `version`, `oid`, `size` in that order with extension lines among them (one per priority, names may contain `-`) and nothing after `size`; takes spec v1 or the hawser and git-media aliases, 64 lowercase hex, and an integer size as Go's `ParseInt` reads it (a sign and leading zeros allowed). Over 23 cases it accepts exactly what `git lfs smudge` accepts, and over 25 more exactly what `git lfs pointer --check` accepts. One known difference: sizes above 2^53 are refused, where git-lfs takes sizes up to 2^63. That includes a valid pointer followed by more than 1024 bytes, which git-lfs still smudges. Extension lines are tested against the spec's example, because git-lfs would run the named extension. |
| R2 | ✅ | Objects are stored at `lfs/objects/aa/bb/<oid>` under the repository root, the same layout git-lfs uses. We read objects native git-lfs stored, and `git lfs fsck` accepts ours. `put` streams into `lfs/tmp/`, hashing and counting on the way, and renames only when SHA-256 and size match; a mismatch leaves no object and no temporary file. It works on git files and on the SQL repository's files. |
| R3 | ✅ | `lfsHandler` serves the Batch API: download and upload; per-object 404 and 422, including a size mismatch; no action for an object already held; a `verify` action after uploads; 409 for a hash algorithm other than sha256. It also serves `GET` with single ranges (206, or 416 with `Content-Range: bytes */N`) and a verified `PUT` (422 on mismatch). `withLfs` puts it next to X8's git handler at one URL. Native `git push` with git-lfs stores verified objects; native `git clone` smudges files identical to the originals, and `git lfs fsck` on the clone passes. |
| R4 | ✅ | `lfsPush` sends one batch, skips held objects, streams uploads from the store and calls `verify`. `lfsFetch` skips objects already held, without any request. A façade (X16b) commit with `.gitattributes` and a pointer, pushed with `lfsPush` and `vcs.push`, clones natively with the file smudged. A native git-lfs push, fetched with our client, is identical. |
| R5 | ✅ | An interrupted download keeps its bytes as parts under `lfs/incomplete/<oid>/`, counted only while they chain from offset 0. Downloads of one object run one at a time in a process, so two concurrent fetches both succeed, and the next fetch sends `Range: bytes=N-` and transfers only the rest. The parts are written so a failing source still leaves what arrived, even on a FilesApi that drops failed writes (`MemFilesApi`). A server answering 200 restarts the download from zero. A 206 for another offset is refused and the held bytes stay. Flipped bytes are refused, with nothing kept; a body that ends early keeps its bytes to resume. |
| R6 | ✅ | 256 MiB through clean, store, upload, download and smudge (transfers handed to the server in-process). Live memory, `heapUsed + arrayBuffers` sampled after a forced GC, stays under 32 MiB. A mutant whose `put` keeps every chunk shows 264 MiB. **Found here:** Node 22's `fetch` (undici 6.29) holds a streamed request body in memory whatever the server's pace (129 MiB for 128 MiB, with a `ReadableStream` or an async-iterable body alike). On Node, large uploads need another `fetch` (passed in `opts.fetch`); in browsers, Chromium streams request bodies only over HTTP/2 or HTTP/3. |
| R7 | ✅ | `authorize(req, op)` per batch, before anything in the request is answered: 401 with `LFS-Authenticate: Basic`, and 403 for a reader uploading. Without `transferAuth`, objects are not marked `authenticated`, so native git-lfs and our client send their credentials on transfers: native push and clone work in this mode. With `transferAuth`, actions carry headers scoped to one object and operation, and a transfer without them, or with another object's, is 401. The client sends each action's headers. |
| R8 | ✅ | In workerd (Miniflare) the store over the SQL repository's files plus the server answer a batch, a `PUT` and a ranged `GET` (206, correct tail). |

### Mutation check

22 mutants. 12 were killed on the first run; the tests were then extended for nine of the survivors, which were all killed.
- Equivalent: L14 (`start >= size`), because `end` is capped at `size - 1`, so that check was removed.
- Cases added for the survivors:
  - a spec v2 version line;
  - a valid pointer followed by more than 1024 bytes and then garbage;
  - an extension line after `size`;
  - leftover temporary files;
  - a `MemFilesApi` store;
  - a pointer with the wrong size;
  - a batch with a size mismatch;
  - a 206 for another offset than asked;
  - a spy on `verify`;
  - a fetch of an object already held, with no requests allowed.

  The cutoff case found a real divergence: our `smudge` refused blobs over 1024 bytes that git-lfs smudges. It now reads the first 1024 bytes, as git-lfs does.

| Mutant | Result |
|---|---|
| L1 lines after size accepted | killed (an extension after size) |
| L2 key order not checked | killed |
| L3 any version | killed (spec v2) |
| L4 negative size | killed |
| L5 no 1024-byte cutoff | killed (pointer + 1100 bytes + garbage) |
| L6 empty file gets a pointer | killed |
| L7 hash not verified | killed |
| L8 size not verified | killed |
| L9 temporary file kept on failure | killed |
| L10 a failing source drops what arrived | killed (`MemFilesApi`) |
| L11 smudge ignores a size mismatch | killed |
| L12 batch serves a size mismatch | killed |
| L13 held object asked for again (upload) | killed |
| L14 `start >= size` | equivalent, removed |
| L15 transfers unchecked | killed |
| L16 no `LFS-Authenticate` | killed |
| L17 no Range on resume | killed |
| L18 a 200 keeps held bytes | killed |
| L19 a wrong resume offset accepted | killed |
| L20 no verify call | killed |
| L21 held objects fetched again | killed |
| L22 bytes not counted | killed |

### Review (#89)

A separate review found 12 defects (11 reproduced by running code). All are fixed; each has a test.

| # | Finding | Fix |
|---|---|---|
| F1 | With `authorize` but no `transferAuth`, every object was marked `authenticated`, so git-lfs sent transfers without credentials: about 2,800 refused PUTs, then a failed push. Our client also dropped its headers on transfers | `authenticated` only with `transferAuth`; the client sends its headers unless the object is `authenticated`; native push and clone tested in this mode |
| F2 | R6 sampled `heapUsed`, which does not count `Uint8Array` memory, so a buffering mutant passed | `heapUsed + arrayBuffers` after a forced GC; the buffering mutant now fails. Found Node's undici buffering streamed uploads |
| F3 | Two fetches of one object into one store both failed and lost the held bytes | Downloads of one object serialized per store, and the waiting one re-checks; parts count only while they chain from 0 |
| F4 | The client trusted the server's object list: an empty answer passed as success | The answer must name exactly the objects asked for |
| F5 | The batch was parsed (and answered 422/409) before `authorize`; no body or object limits | Authorized first; body ≤ 1 MiB and ≤ 1000 objects (413); headers minted only for objects that get actions |
| F6 | `complete()` dropped the held parts on any failure, so a transient read error restarted from zero | Parts are dropped only on a verification mismatch |
| F7 | A `move` that returned false counted as stored | Treated as a failure unless the object is there |
| F8 | Six pointer divergences: the git-media alias, a BOM, duplicate priorities, `ext-0-a-b`, NEL, sizes above 2^53 | All but the last fixed; checked against `git lfs pointer --check` (sizes above 2^53 stay refused, documented) |
| F9 | Suffix ranges were 416; unusable ranges were 416 instead of ignored; `If-Range` ignored | RFC 9110: `bytes=-N`; unusable ranges ignored (200); the oid as a strong ETag for `If-Range` |
| F10 | `objects: [null]` gave 500; a malformed verify body gave 404 | Per-object 422; verify 422 |
| F11 | `Content-Length` trusted unchecked; no size limit on PUT | 400 for an invalid length; `maxObjectSize` (batch 422, PUT 413, enforced while streaming) |
| F12 | Bodies released but not cancelled; duplicate pointers fetched twice; hrefs from the request's origin (wrong behind a proxy); 200 required where 2xx is fine | Early-stopped bodies cancelled; duplicates dropped; `publicUrl`; any 2xx accepted |

Mutation check of the fixes: 24 mutants (N1–N24), all killed.

A test-harness finding: a client that applies backpressure to a response while the test server closes the connection makes undici throw `assert(!this.paused)` (an unhandled error). F3 therefore slows the server instead of the client.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/pointer.ts` | **Adopt** | git-lfs's encoder and decoder, oracle-checked |
| `src/store.ts` | **Adopt** | git-lfs's layout, verified writes, resumable parts on any FilesApi |
| `src/server.ts`, `src/client.ts` | **Adopt** | Batch API and basic transfer, both sides, native git-lfs interop |

## Open threads

1. **Gitea as a second oracle**, with our client against a production LFS server. Blocked here: no
   Docker daemon, and running a downloaded Gitea binary was not permitted in this session. Our
   uploads are sent chunked without `Content-Length`; some servers may require it, so the size
   should be sent once a server is tested.
2. **Concurrency** (git-lfs runs 8 transfers at once), retries with backoff, `expires_at`/`expires_in`
   handling, and batches split at git-lfs's 100-object limit. Downloads of one object are
   serialized within a process only; across processes, parts that overlap are dropped and the
   verify protects the object, but two processes can still waste a transfer.
3. **Uploads in bounded memory on Node**: undici holds streamed request bodies (R6). Use a
   `node:http` fetch for large uploads, or send one with `Content-Length`. In browsers, request
   streams need HTTP/2 or HTTP/3; over HTTP/1.1, a file-backed `Blob` (OPFS `getFile()`) is the
   bounded way.
4. **The locking API** (`locks`, `locks/verify`), and the transfer adapters tus, multipart and
   ssh (`git-lfs-transfer`).
5. **Filters in the façade**: `.gitattributes`-driven clean on commit and smudge on checkout (X14's
   working tree); finding the pointers to push in a ref range (git-lfs's `pre-push`).
6. **P2P** (X12, next): the same batch served per peer mount, only missing chunks sent.
