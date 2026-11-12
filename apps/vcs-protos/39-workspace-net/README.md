# 39 — Can folders sync over a network transport, kept in step by a watcher?

Plan id **X17b** (workspace sync over the network). Status: **open**.

## Question

X17 (38) keeps folders in step through git history, but its endpoints share a process: a sync
reads the other endpoint's objects directly. Across devices, an endpoint only reaches another
through a transport. Can the same history-based sync run over git's own wire protocol — each
endpoint serving its repository as a `FetchHandler` (X8's smart HTTP: upload-pack and
receive-pack) across httpeers' bridge, the others fetching, merging and pushing back — and can a
folder watcher keep endpoints in step without anyone calling `sync`?

## Reject condition

Rejected if endpoints syncing only over the transport fail to converge on one commit and the same
files; if a push that loses a race overwrites the remote's newer commits; if a transport that
fails halfway leaves an endpoint unable to sync later, or a repository native git refuses; or if
the watcher misses a change or syncs once per write in a burst.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| N1 | **Over the transport.** Two endpoints, each serving `serveEndpoint(ep)` across httpeers' `pairedLinks`, edit different and the same files; `syncWith(a, b)` (fetch, X17's deterministic merge, push) leaves both on one commit and the same files — the remote's folder included, checked out after the push arrives. |
| N2 | **Lost races retry.** The remote commits between our fetch and our push: the push is refused as a non-fast-forward (never forced), and `syncWith` fetches, merges and pushes again; nothing the remote committed is lost. |
| N3 | **Property test.** 50 random schedules over three endpoints syncing only through the transport (a hub and two spokes, edits and syncs interleaved): after a final round every endpoint holds the same commit and files, and every edit no other endpoint touched survives. |
| N4 | **Transport failure.** A link that fails during the fetch or during the push (requests rejected after N bytes) leaves both repositories valid (`git fsck --strict`); the next sync over a working link converges. |
| N5 | **Watcher.** `watchEndpoint(ep, peers)` notices a changed folder (portably: polling the FilesApi, no `node:fs`) and syncs it to every peer: an edit on A appears in B's folder with no `sync` call; a burst of 20 writes in quick succession causes at most 3 syncs (debounced); edits on both sides converge; `stop()` ends it. |
| N6 | **Portable.** `src/` has no `node:` imports; endpoints run on in-memory FilesApis. |

## Scope — what this slice does NOT do

- A real network link (libp2p, WebSocket): httpeers' `pairedLinks` runs the same bridge code over
  a `MessageChannel` (X8c); webrun-wire's port stack over WebSocket is the next transport.
- Access control (X8c's Biscuit tokens apply unchanged) and discovery of peers.
- Filesystem notification APIs (`fs.watch`, FileSystemObserver): polling is the portable floor.
