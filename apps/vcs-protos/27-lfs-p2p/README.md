# 27 — Can large files move between httpeers peers: per peer mount, only missing chunks, resumable, verified?

Plan id **X12** (large files P2P). Status: **answered — yes: LFS per peer mount behind mesh roles, a negotiated `ranged` adapter, downloads from every holder, bad peers found**.

## Question

X10a gave Git LFS on our stores (pointers, a verified store, the Batch API and basic transfer, both
sides). X8c gave git between httpeers peers behind Biscuit-verified roles. Peers holding large
files should serve them to each other the same way. Can the following work, in X12's terms
("LFS batch per peer mount; only missing chunks sent; resume; mandatory verify")?
- each peer serves LFS next to its git at its mount, authorized by its mesh roles;
- uploads and downloads move in chunks, so that:
  - only the byte ranges the other side lacks are sent;
  - no single call outlasts the bridge's bound on a response head;
  - an interrupted transfer resumes where it stopped;
- a download takes its chunks from every peer that holds the object;
- nothing becomes visible until the whole object verifies, and a peer that serves bad bytes is
  identified and does not stop the download.

## Reject condition

Rejected if any of these happens:
- the mesh's roles can be exceeded through LFS (an upload without write access, a download
  without read access);
- a transfer resends bytes the receiver already holds;
- a long upload fails on the bridge's timeout;
- an unverified object becomes visible;
- one bad peer makes a download fail while a good peer holds the object;
- native git-lfs over plain HTTP no longer works against the same server.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | **LFS on the mesh.** `meshLfsHandler(store, { issuer, rules })` puts X10a's handler behind httpeers' `withAccess`; `meshRepoHandler` serves git and LFS at one mount. Over `pairedLinks`, an admin pushes git and LFS objects to a peer, and a member clones and fetches them back, byte-identical. No token gives 401. A member uploading without `contributors` gets 403; with `contributors`, a member's upload is allowed. `hidden` can download. |
| R2 | **A `ranged` transfer adapter, negotiated.** A client offering `["ranged", "basic"]` gets `ranged`; one offering only `basic` (native git-lfs) gets `basic`. `ranged` has the basic transfer's actions plus: an upload as `PUT`s with `Content-Range: bytes a-b/size`, each stored as a part and verified as a whole when the parts cover the object; `HEAD` on the object's href reports the held ranges (`x-lfs-held`); downloads as ranged `GET`s. Native `git push` and `git clone` with git-lfs over plain HTTP still work against the same handler. Our client against a basic-only server falls back to `basic`. |
| R3 | **The bridge's bound.** With the bridge's request timeout at 1.5 s and an upload throttled to take over 3 s, a `basic` upload fails, and a `ranged` upload in 1 MiB chunks succeeds and verifies. |
| R4 | **Only missing chunks, resume.** An upload cut after 2 of 6 chunks, retried, sends only the remaining 4 (counted in requests and bytes). A download cut part-way resumes from the held ranges; the bytes received over both attempts equal the object's size. |
| R5 | **Many sources.** An object held by two peers is fetched by a third from both: both serve chunks, and the bytes received equal the object's size. If one source fails part-way, the other serves the rest, still with no byte received twice. |
| R6 | **Mandatory verify, bad peers.** A source serving altered bytes makes the assembled object fail verification. The client then takes the object from each source alone, keeps the one that verifies, and reports the bad source. Nothing unverified is visible at any point. |
| R7 | **Bounded memory over the bridge.** A 64 MiB object fetched over `pairedLinks` from two sources in 4 MiB chunks: live memory grows by less than 32 MiB. |

## Scope — what this slice does NOT do

- Discovery: which peers to ask is given to the client (the mesh's membership is known to it).
- Native git-lfs over the mesh (it would need a custom transfer agent), Xet chunking (X11), and
  per-chunk hashes from an untrusted peer (whole-object verification is what is mandatory).

## Answer

Yes. Two pieces on top of X10a and X8c:
- `meshLfsHandler` (`src/mesh-lfs.ts`): X10a's handler behind httpeers' `withAccess`, with X8c's
  capabilities.
- `lfsFetchFrom` (`src/swarm.ts`): downloads from many sources.

X10a gained what they need: store parts at any offset with held ranges; the `ranged` adapter on
the server (`ranged: true`) and in the client (offered in every batch, chosen by the server);
`lfsBatch`, `missingChunks` and `transferHeaders` exported.

| # | Result | How |
|---|---|---|
| R1 | ✅ | Over `pairedLinks` with Biscuit tokens: an admin pushes a façade commit (pointer plus `.gitattributes`) and its LFS object to B; a member clones and fetches them back, byte-identical. With no token: 401. A member's upload without `contributors`: 403. `hidden` downloads. With `contributors`, a member's upload is allowed. A role holding only `git:write-own` cannot download (403). |
| R2 | ✅ | `ranged` is chosen when offered and the server enables it; native git-lfs offers `basic` and gets it, and its push and clone over plain HTTP still work against the same handler. Parts arrive in any order. Each part is kept apart per uploader and declared size, visible only once whole, exactly its range's length, and never overlapping what is held (409). `HEAD` with `x-lfs-size` on a missing object answers 404 with that uploader's `x-lfs-held: 0-1048575,2097152-3145727`. An empty object goes `basic`. The part that completes the coverage verifies the object (`x-lfs-complete: true`). A part shorter than its `Content-Range` is refused (400). Against a basic-only server, our client falls back to `basic`. |
| R3 | ✅ | Bridge timeout 1.5 s, upload throttled to 2 MiB/s: a 6 MiB `basic` upload fails and stores nothing; `ranged` in 1 MiB chunks succeeds (eight requests: HEAD, six PUTs and `verify`) and verifies. |
| R4 | ✅ | An upload cut after 2 of 6 chunks, retried, sends 4 PUTs and 4 MiB. Held ranges in the middle (`[1 MiB, 2 MiB)`) are skipped too: 3 MiB of 4 are sent. A download cut part-way resumes from the held ranges, and the bytes over both attempts equal the object's size. |
| R5 | ✅ | From two holders in 1 MiB chunks, both serve and the bytes received equal the size. If one holder fails with 502, with no bytes sent, or is cut mid-chunk, the rest of its chunk goes back to the queue and the other holder serves it: still exactly the size. A 206 for another range than asked is refused, nothing is written, and the holder is dropped. |
| R6 | ✅ | A source altering bytes makes the assembled object fail verification, and the parts are dropped. Each holder is then tried alone until one copy verifies; B is first and verifies, so C is found by the recorded chunk hashes alone. A source that cuts its altered chunks short is found by the hashes of the bytes it did deliver. The recorded chunk hashes are compared with the verified object, and the source is reported: `{ bad: ["C"] }`. When every source alters bytes, the download is refused and nothing becomes visible. |
| R7 | ✅ | 64 MiB from two sources over `pairedLinks` in 4 MiB chunks: live memory grew by 2.7 to 4.4 MiB across runs. |

`ranged` uploads send each chunk as a buffer of known length rather than a streamed body. That
also avoids X10a's two upload findings: undici holding streamed bodies on Node, and Chromium
streaming request bodies only over HTTP/2 or HTTP/3.

### Mutation check

22 mutants. 12 were killed on the first run. Two survivors were equivalent:
- P13, the final `HEAD` check when the last part did not report completion: the `verify` action
  then fails the same way, so the check stays for servers without `verify`.
- P22, the holder's size checked against the pointer: a compliant server answers 422 without
  actions, and a lying peer's bytes fail verification anyway, so the check was removed.

The other 8 were killed after tests were added:
- overlapping parts;
- `complete()` with a gap;
- per-operation tokens on `HEAD`;
- an object that appears between the batch and the `HEAD`;
- held ranges in the middle;
- an upload-only role trying to download;
- a holder cut mid-chunk while another carries on;
- a 206 at a shifted offset. The first version of this case shifted to `bytes=0-99`, which is
  correct for the chunk at offset 0, so it changed nothing.

| Mutant | Result |
|---|---|
| P1 overlapping parts kept | killed |
| P2 ranges not merged | killed |
| P3 `complete()` without full coverage | killed |
| P4 `ranged` never chosen | killed |
| P5 `ranged` chosen when not offered | killed |
| P6 `HEAD` needs a download token | killed |
| P7 `Content-Range` ignored | killed |
| P8 part length unchecked | killed |
| P9 the completing part does not complete | killed |
| P10 `HEAD` 200 (object meanwhile) not skipped | killed |
| P11 held ranges ignored | killed |
| P12 gaps around held ranges wrong | killed |
| P13 no final check | equivalent (`verify`) |
| P14 download without `git:read` | killed |
| P15 upload with `git:read` only | killed |
| P16 no `git:write-own` uploads | killed |
| P17 the rest of a failed chunk lost | killed |
| P18 the rest of a failed chunk fetched whole again | killed |
| P19 a 206's offset unchecked | killed |
| P20 bad chunk sources not identified | killed |
| P21 one worker only | killed |
| P22 holder size checked | equivalent, removed |

### Review (#90)

A separate review found 12 issues (7 reproduced by running code). All are fixed; each has a test.

| # | Finding | Fix |
|---|---|---|
| F1 | A holder failing after the other workers had gone idle aborted the download, though a healthy holder held the object; a failure that was not a mismatch skipped the per-holder retries | Workers wait until nothing is queued or in flight; any first-round failure goes on to the holders one at a time, from what is held |
| F2 | A part declared for another size (`bytes 0-1999/3000`) blocked every later upload of the object | Parts are kept per uploader (the mesh's proven peer) and declared size: one uploader's bytes cannot touch another's; a client whose parts are all held re-sends its last part, and the server then completes |
| F3 | Two uploaders of one object: a part rewritten at the same offset truncated the other's, verification failed and dropped every part; unfinished parts were listed as held | Parts are written aside and renamed when whole (never in place, never seen unfinished); per-uploader scopes; completion under the object's lock, reading exactly each part's listed size |
| F4 | Overlapping parts were stored (unbounded disk) and the mesh had no size limit | A part overlapping what is held is refused (409); `meshLfsHandler` defaults `maxObjectSize` to 5 GiB |
| F5 | A source cutting its altered chunks short escaped blame | The bytes a failed chunk delivered are hashed and recorded too |
| F6 | A part with extra bytes was half-stored (400) and wedged the upload | A part is kept only with exactly its range's length |
| F7 | Empty objects could not go with `ranged` | They go `basic` |
| F8 | `chunkSize: 0` looped forever | Chunk sizes are integers from 1 byte to 64 MiB |
| F9 | A holder answering 200 to ranges was dropped | Read from the chunk's start |
| F10 | Failed batches (401, 403) were hidden behind "not found on any source" | Reported in that error |
| F11 | `HEAD` with an upload token gave the object's size | 200 without a length |
| F12 | R3 claimed seven requests and tested `≥ 6`; R6's attribution was not isolated | Exactly 8 (HEAD, six PUTs, `verify`); R6's order makes the chunk hashes the only path that finds C |

Two of the review's tests needed a fix of their own: a test stream that enqueued bytes and failed
in the same step delivered nothing, because an error discards what is queued. They now deliver
the bytes, then fail on the next pull.

Mutation check of the fixes: 13 mutants, 12 killed. Q1 (idle workers leave) survives: since F1's
second fix, the per-holder retries finish what the parallel round left, so the outcome is the same
and only one extra round is spent. Both are kept.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/mesh-lfs.ts` | **Adopt** | LFS per peer mount with the same roles as git |
| `src/swarm.ts` | **Adopt** | multi-source, resumable, no byte twice, bad peers found by recorded chunk hashes |
| X10a's `ranged` adapter, parts at any offset | **Adopt** | short, resumable, length-known transfers: the bridge's bound, browsers over HTTP/1.1 |

## Open threads

1. **Discovery**: which peers hold an object (today the caller lists the sources); announcements
   on the mesh, or a batch to every member.
2. **Per-chunk verification before assembly**: chunk hashes from a trusted manifest (e.g. Xet's,
   X11) would identify a bad source without the whole-object fallback.
3. **Parallelism**: more than one request per holder, and chunk sizes tuned to the link.
4. **Quotas** for members' uploads (`git:write-own`); expiry of unfinished parts (per-uploader
   scopes are bounded by a part's declared size, but not in number); garbage collection of LFS
   objects that no ref points to (X18 for LFS).
5. **Native git-lfs over the mesh**: a custom transfer agent (`lfs.customtransfer`) speaking to a
   local bridge.
