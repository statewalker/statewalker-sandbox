# 27 — Can large files move between httpeers peers: per peer mount, only missing chunks, resumable, verified?

Plan id **X12** (large files P2P). Status: **open**.

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
