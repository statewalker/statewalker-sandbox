# 21 — Can git's smart protocol (v2) run over a plain fetch handler, both ways, with native git?

Plan id **X8** (git over httpeers), slice **X8a: smart protocol — fetch side**. Status: **open**.

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
| R5 | Streaming: for a repository of ~32 MiB of blobs, the first pack byte reaches the client before the server has read half of the objects (counted); an aborted request stops the generation (counted reads stop). |
| R6 | Negotiation: on a 300-commit history with 3 new commits, our client sends ≤ 64 haves and the pack holds only the 3 commits' objects; git's flush rule (16, doubling over stateless HTTP) and give-up after 256 haves in vain. |
| R7 | Hostile requests: a want the server does not advertise ("not our ref"), malformed pkt-lines, an oversized line, an unknown command or argument → an error response (ERR / 4xx), never a crash, and no pack. |

## Scope — what this slice does NOT do

- Push (receive-pack): X8b. Protocol v0/v1 serving (git ≥ 2.26 asks v2 over HTTP; a request
  without `Git-Protocol: version=2` is refused with a clear error). `fetch --deepen`,
  `--unshallow`, `deepen-since`, `deepen-not`, `filter`, `packfile-uris`: later.
- Gitea in Docker (the plan's oracle): `git http-backend` is the native reference here.
