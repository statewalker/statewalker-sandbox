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
  without `Git-Protocol: version=2` is refused with a clear error). `fetch --deepen`,
  `--unshallow`, `deepen-since`, `deepen-not`, `filter`, `packfile-uris`: later.
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
  (git's default). Stateless negotiation: ACK the haves present, "ready" once every want reaches
  a common commit (git's ok_to_give_up, walking no older than the oldest common). The pack is
  X6c's walk with the deepen boundary as shallow commits, written by X6e (or X6d) and streamed in
  side-band-64k through a bounded channel: progress on band 2 while searching, a cancelled
  response aborts the generation, an error after the start goes on band 3. Requests over 64 MiB,
  malformed packets, unknown commands, capabilities or arguments get an `ERR` packet. A request
  without `Git-Protocol: version=2` is refused (400).
- **Client**: discovery (with or without the "# service" preamble), `ls-refs` limited to the
  refspecs' prefixes, git's default negotiator (newest first; ACKed haves mark their ancestors
  common; rounds of 16 doubling; commons re-sent each round; give-up as amended above), the pack
  demultiplexed straight into `installPack` (thin bases completed from the store), shallow-info
  into git's shallow file, refs updated forced or fast-forward, tags auto-followed. `clone` with
  `depth` is single-branch, as git's.

| | |
|---|---|
| native `git clone` from our server (files, SQL) | refs, HEAD, objects equal; `fsck --strict` clean |
| native `clone --depth 1` | one commit, git's shallow file |
| native `git fetch` after 2 commits | exactly the new objects |
| our clone from `git http-backend` | refs and HEAD equal; `fsck --strict` clean; `depth: 1` → one commit and git's shallow file; incremental fetch: the new objects and the followed tag |
| our client ↔ our server (SQL → files) | logs equal |
| negotiation, 3 new commits on 300 | 16 haves, 1 round, 9 objects |
| streaming (64 × 512 KiB blobs) | search: progress after 5 of 202 reads, pack after 137; reuse: pack after 5 of 70; abort: reads stop at 2 |

## Verified

All 11 Node tests pass (`pnpm test 21-smart-http`). The tests were written first (red commit).

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
