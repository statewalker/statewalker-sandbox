# 26 — Can Git LFS run on our stores, both ways with native git-lfs, verified, resumable, in bounded memory?

Plan id **X10** (LFS), slice **X10a: pointers, store, batch API, basic transfer**. Status: **open**.

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
| R2 | **Store.** Objects live at git-lfs's layout, `lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`, under the repository root, so native git-lfs in a git-files repository finds what we store (`git lfs fsck` clean) and we find what it stored. `put` streams into `lfs/incomplete/`, checks SHA-256 and size, then renames. A mismatch is refused and leaves nothing visible. It works on the git-files and the SQL repository. |
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
