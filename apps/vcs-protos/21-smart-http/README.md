# 21 — Can git's smart protocol (v2) run over a plain fetch handler, both ways, with native git?

Plan id **X8** (git over httpeers), slice **X8a: smart protocol — fetch side**. Status: **answered — yes: native git clones, shallow-clones and fetches from our handler (files and SQL), our client from `git http-backend`; git's negotiation; streamed; hostile requests refused.**

## Question

X6 ingests and exports packs; nothing yet speaks git's wire protocol. httpeers and webrun-wire
carry HTTP as `Request → Response` handlers (a `FetchHandler`), so the git server must be one:
`uploadPackHandler(repo)`. And a client must fetch from any smart-HTTP server (native
`git http-backend`, Gitea, GitHub) with global `fetch`. Can both be written over X6's streaming
export/ingest — protocol v2 (`ls-refs`, `fetch` with negotiation, shallow, side-band-64k), the
pack streamed as it is generated — so that native git clones and fetches from ours, and ours from
native git's?

## Reject condition

Rejected if native git refuses our server's responses or our client's requests, if the response
waits for the whole pack before its first byte (X8's red test: "first byte before pack generation
ends"), if negotiation sends the whole history on an incremental fetch, or if a hostile request
can crash the server or make it serve objects it does not advertise.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | pkt-line and side-band codecs: round trip; input split at every byte offset decodes the same; flush/delim/response-end; refused: lengths 0003 or below that are not special, above 65520, non-hex. |
| R2 | Native git (protocol v2 over HTTP, `node:http` serving the handler) clones from our server — files and SQL backends — with refs, HEAD and objects equal and `fsck --strict` clean; `clone --depth 1` gives a shallow clone of one commit; after new commits, `git fetch` transfers only the new objects (the received pack holds no object the client had). |
| R3 | Our client clones from `git http-backend` (v2): refs, HEAD, objects equal; `fsck` (by git, files backend) clean; `depth: 1` gives one commit with git's shallow file; an incremental fetch receives only the new objects. |
| R4 | Our client against our server, SQL backend serving a files-backend client: logs equal. |
| R5 | Streaming: for a repository of ~32 MiB of blobs, the first pack byte reaches the client before the server has read half of the objects (counted); an aborted request stops the generation (counted reads stop). *Amended — see below.* |
| R6 | Negotiation: on a 300-commit history with 3 new commits, our client sends ≤ 64 haves and the pack holds only the 3 commits' objects; git's flush rule (16, doubling over stateless HTTP) and give-up after 256 haves in vain. *Amended — see below.* |
| R7 | Hostile requests: a want the server does not advertise ("not our ref"), malformed pkt-lines, an oversized line, an unknown command or argument → an error response (ERR / 4xx), never a crash, and no pack. |

## Scope — what this slice does NOT do

- Push (receive-pack): X8b. Protocol v0/v1 serving (git ≥ 2.26 asks v2 over HTTP; a request
  without `Git-Protocol: version=2` is refused with a clear error). `deepen-relative`
  (`fetch --deepen`, refused with an ERR), `deepen-since`, `deepen-not`, `filter`,
  `packfile-uris`: later. Symbolic refs other than HEAD are not listed (X5's ref store lists
  direct refs only).
- Gitea in Docker (the plan's oracle): `git http-backend` is the native reference here.

### Criteria amended while implementing (both towards git's behaviour)

- **R5**: with delta search (X6e, as git's pack-objects) the pack is written only once the search
  has read the candidates, as in git, which streams progress meanwhile ("Compressing objects").
  The criterion is checked as: with search, the first response byte (band-2 progress) arrives
  before half of the reads; with `search: false` (X6d's reuse), the first pack byte does; abort
  stops the reads in both.
- **R6**: git gives up after 256 haves in vain **only once it has seen an ACK** (v2's
  `seen_ack && in_vain >= MAX_IN_VAIN`, v0's `got_continue`); with no ACK it sends every have,
  then `done`. And "done" is decided as a request is built, so the round that passes 256 is sent
  whole. The test now checks both: an early ACK then 600 unrelated commits → exactly 16 + 32 + 64
  + 128 + 256 = 496 haves; 300 unrelated commits and no ACK → all 300.

## Answer

**Yes.** `uploadPackHandler(repo, { search })` is a `(Request) => Promise<Response>`; `fetchFrom(url,
repo, { refspecs, depth, shallow })` and `clone(url, repo)` use global `fetch`.

- **Server**: the v2 capability advertisement (as `git http-backend` in v2, no "# service"
  preamble); `ls-refs` (symrefs, peel, ref-prefix, unborn); `fetch` (want, have, done, thin-pack,
  include-tag, no-progress, ofs-delta accepted, shallow, deepen). Wants must be advertised tips
  or commits reachable from them (git v2: a fetch by commit id, a ref moved since `ls-refs`);
  anything else is "not our ref". Wants and haves are sets (duplicates cost nothing).
  Request bodies are inflated when gzipped (git's remote-curl compresses those over 1 KiB).
  Stateless negotiation: ACK the haves present, "ready" once every want reaches
  a common commit (git's ok_to_give_up, walking no older than the oldest common). `deepen N` computes
  the new boundary; a shallow client's commits now above it are unshallowed and their parents
  sent (X6c's walk gains `receiverShallow`: the client's haves do not make those parents
  uninteresting) — native `fetch --depth N` and `--unshallow` on a shallow clone work.
  `include-tag` sends every tag of a chain. The pack is X6c's walk with the boundary as shallow
  commits, written by X6e (or X6d) and streamed in
  side-band-64k through a bounded channel: progress on band 2 while searching, a cancelled
  response aborts the generation, an error after the start goes on band 3. Requests over 64 MiB,
  malformed packets, unknown commands, capabilities or arguments get an `ERR` packet. A request
  without `Git-Protocol: version=2` is refused (400).
- **Client**: discovery (with or without the "# service" preamble), `ls-refs` limited to the
  refspecs' prefixes, git's default negotiator (newest first, annotated tags peeled; ACKed haves
  mark their ancestors common, and a popped common commit makes its parents common — so with or
  without "ready" the common history is not sent; rounds of 16 doubling; commons re-sent each
  round; give-up as amended above), the pack
  demultiplexed straight into `installPack` (thin bases completed from the store), shallow-info
  into git's shallow file, refs updated one transaction each, forced or fast-forward (a
  non-fast-forward ref is reported in `rejected`, the others update, as git's fetch), tags
  auto-followed only when their whole chain is here; a refspec without a destination fetches the
  objects only. `depth` needs a shallow store (refused otherwise) and re-asks for tips already
  here (deepening). `clone` with `depth` is single-branch, as git's; an empty remote's clone takes
  its unborn HEAD (`ls-refs unborn`).

| | |
|---|---|
| native `git clone` from our server (files, SQL) | refs, HEAD, objects equal; `fsck --strict` clean |
| native `clone --depth 1` | one commit, git's shallow file |
| native `git fetch` after 2 commits | exactly the new objects |
| our clone from `git http-backend` | refs and HEAD equal; `fsck --strict` clean; `depth: 1` → one commit and git's shallow file; incremental fetch: the new objects and the followed tag |
| our client ↔ our server (SQL → files) | logs equal |
| negotiation, 3 new commits on 300 | 16 haves, 1 round, 9 objects |
| streaming (64 × 512 KiB blobs) | search: progress after 5 of 202 reads, pack after 137; reuse: pack after 5 of 70; abort during the search or the pack: the reads stop |

## Verified

All 22 Node tests pass (11 for R1–R7, 11 from the review of #81) (`pnpm test 21-smart-http`). The tests were written first (red commit).

### Mutation check

| Mutation | Caught by |
|---|---|
| H1 no "not our ref" check | R7 |
| H2 never "ready" | R6 |
| H3 no ACK lines | R6 (no give-up after the ACK) |
| H4 deepen ignored | R2 (shallow clone) |
| H5 haves ignored | R6 (whole history sent) |
| H6 the pack's abort signal not passed | R5 (abort during the search) |
| C1 commons not re-sent each round | R6 (stateless: the final pack) |
| C2 flush not doubling | R6 (496) |
| C3 give up without an ACK | R6 (600 unrelated haves) |
| C4 no tag auto-follow | R3 |
| P1 lengths 1–4 accepted | R1 |
| P2 band 3 ignored | R1 |

The mutation run found that progress was only flushed with the first pack chunk; it now goes
straight into the response while the search reads (band 2), and an abort during the search stops
it.

### Review of #81

| Finding | Resolution |
|---|---|
| gzip request bodies (git compresses POSTs over 1 KiB) not handled: native clones of repos with ~30 refs, fetches with ~20+ haves failed | Inflated (`Content-Encoding: gzip`); native clone of 30 branches |
| Tag chains: include-tag sent only the outer tag; auto-follow created refs to incomplete chains | Every tag of the chain sent; auto-follow checks the chain |
| `fetch --depth N` / `--unshallow` on a shallow clone did nothing | Real deepening: unshallow lines, the parents sent (`receiverShallow` in X6c's walk) |
| A producer error while the client cancels: unhandled rejection, process exit | The error write's rejection is caught |
| One open file per annotated tag per request | Tag objects read through or closed |
| Duplicate wants multiplied `ok_to_give_up` walks | Sets; one shared walk memory |
| Client: `depth` with the tips already here sent nothing | Re-asks (git's fetch-pack) |
| Client: ancestors of an ACKed commit not yet seen were sent as haves (296 vs git's 16 without "ready") | Common propagates on pop (git's consecutive negotiator) |
| Non-tip wants refused (git v2 serves reachable ones: fetch by id, moved refs) | Reachable wants served; unreachable or unknown: "not our ref" |
| One non-fast-forward ref aborted every update | Rejected alone, reported |
| `depth` without a shallow store left a broken repository | Refused |
| Refspec without a destination fetched nothing; an empty remote's clone kept the local HEAD; progress never reached 100%; local annotated tags not peeled in negotiation; an ERR in the advertisement misreported | Fixed |
| Symbolic refs other than HEAD not listed | Noted (X5's store lists direct refs) |

Mutations of the fixes, all caught by the review tests: G1 gzip ignored, G2 include-tag of the
outer tag only, G3 auto-follow without the chain check (it also showed `followTags: false` still
sent `include-tag`; git's `--no-tags` does not), G4 haves propagating past the receiver's shallow
commits, G5 no unshallow lines, G6 the error write not caught, G7 non-tip wants refused, G8 no
common propagation on pop, G9 no request when deepening local tips, G10 depth without a shallow
store, G11 one non-fast-forward aborting all, G12 refspec without destination ignored, G13
`unborn` not asked.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/pkt-line.ts` | **Adopt** | git's framing and side-band, strict |
| `src/server.ts` | **Adopt** (fetch side) | v2 upload-pack over a fetch handler; push and v0 next |
| `src/client.ts` | **Adopt** (fetch side) | git's negotiator and shallow; push next |

## Open threads (ranked by how much later work they would invalidate)

1. **Push (X8b)**: receive-pack (report-status, atomic, delete, push options) on both sides, with
   X6b's ingest and X5's ref transactions; the same handler.
2. **httpeers (X8)**: mount the handler on a peer; Biscuit `authorize` per service and ref;
   `refs/peers/<id>/*`; push > 30 s.
3. **Gitea oracle (X0)**: run the client against Gitea (v2) and GitHub; protocol v0 for old servers.
4. `fetch --deepen` / `--unshallow`, `deepen-since`, `deepen-not`, `filter` (partial clone),
   `wanted-refs`, `packfile-uris`.
