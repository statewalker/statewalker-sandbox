# 22 — Can git push run over the same fetch handler, both ways, with native git?

Plan id **X8** (git over httpeers), slice **X8b: smart protocol — push side**. Status: **open**.

## Question

X8a serves and fetches with protocol v2; git has no push in v2: `git push` over HTTP speaks
receive-pack in protocol v0 (`info/refs?service=git-receive-pack` with "# service" and the refs
advertisement, then commands, push options and a thin pack; report-status, side-band-64k). Can the
server accept pushes — X6b's ingest completing the thin pack, git's connectivity check, X5's ref
transaction (atomic or per ref, compare-and-set) — and the client push with X6e's thin packs, so
native git pushes to ours and ours to native git's?

## Reject condition

Rejected if native git refuses our responses or ours, if a push can leave refs pointing at objects
that are not all present (connectivity), if an atomic push can apply partially, if a stale old
value can overwrite a concurrent update, or if a push holds the whole pack in memory.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Native `git push` to our server (files and SQL backends): a new branch, a fast-forward, a forced non-fast-forward, a delete, an annotated tag; `--atomic` with one rejected ref applies none; refs equal what git's own server would hold; a native clone afterwards passes `fsck --strict`. |
| R2 | Our client pushes to `git http-backend` (`http.receivepack`): new branch, fast-forward, a non-fast-forward refused without force and applied with it, delete, atomic; `fsck` of the server repository clean. |
| R3 | Concurrency: a command whose old value is stale (the ref moved since the advertisement) is refused (`ng … stale`/lock); in an atomic push nothing changes. |
| R4 | Connectivity and integrity: a pack that lacks an object the new tip needs → `ng … missing necessary objects`, refs unchanged; a corrupt pack → `unpack <error>`, refs unchanged, temporaries removed. |
| R5 | Thin packs: our client's pack is thin against the remote's refs; its size within 1.10× of native `git push`'s for the same update. |
| R6 | Streaming: pushing a 64 MiB blob, the server holds < 16 MiB extra live (the request body streams into the index). |
| R7 | Hostile and invalid: malformed command lines, invalid ref names (git's check-ref-format) → `ng … invalid`, commands without the pack they need, an oversized request → refused, no crash; hooks: a `preReceive` callback can refuse the whole push, an `update` callback one ref (`ng … hook declined`). |

## Scope — what this slice does NOT do

- Push certificates, `receive.fsckObjects` (a later fsck slice), `report-status-v2` option lines,
  `denyCurrentBranch` with a work tree (the stores are bare).
