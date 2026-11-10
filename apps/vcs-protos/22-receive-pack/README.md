# 22 — Can git push run over the same fetch handler, both ways, with native git?

Plan id **X8** (git over httpeers), slice **X8b: smart protocol — push side**. Status: **answered — yes: native `git push` to our handler (files and SQL) and our client to `git http-backend`; atomic, compare-and-set, connectivity-checked, thin, streamed, hooks.**

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

## Answer

**Yes.** `receivePackHandler(repo, { preReceive, update })` (and `gitHandler`, which routes
upload-pack and receive-pack) is a `(Request) => Promise<Response>`; `push(url, repo, { refspecs,
atomic, pushOptions })` uses global `fetch` with a streamed request body.

- **Server**: the v0 advertisement (`capabilities^{}` for an empty repository) with report-status,
  delete-refs, side-band-64k, quiet, atomic, ofs-delta, push-options; commands, push options, then
  the pack streamed from the request into X6b's install (gzip bodies inflated; a size limit on the
  inflated stream). Then, per ref: git's ref-name rules ("funny refname"), no deletion of HEAD's
  branch, git's connectivity check (X6c's walk from the new tip down to what the refs reach: every
  object present), the `preReceive` and `update` hooks, and X5's transaction — compare-and-set on
  the old value, one transaction for `atomic` (a ref failing a check fails them all), one per ref
  otherwise. report-status in side-band. Objects of a refused push stay in the store (git
  quarantines and drops them): garbage for X18.
- **Client**: the advertisement, refspecs (`[+]src:dst`, `:dst`), git's rules checked locally (a
  branch must fast-forward from a remote tip known here — "fetch first" otherwise; a tag is not
  replaced without force; an atomic push refused locally sends nothing), one POST with the
  commands and a thin pack (X6e's search against the remote's refs) streamed as produced
  (`duplex: "half"`), report-status per ref.

| | |
|---|---|
| native push to ours (files, SQL) | new branch, fast-forward, non-fast-forward refused then forced, tag, delete; `--atomic` with a declined ref applies none; a mirror clone passes `fsck --strict` |
| our push to `git http-backend` | the same operations; the server repository passes `fsck --strict` |
| stale old value | `ng … failed to update ref (stale old value)`; atomic: nothing changes |
| a pack without the tip's tree and blob | `ng … missing necessary objects`; corrupt pack: `unpack …`, no temporaries left |
| thin pack | ours 1 013 B, native 948 B (1.07×) |
| a pushed 64 MiB blob | server +2.0 MiB live |
| hostile | invalid names → `ng … funny refname`; malformed commands → 400; a non-delete without a pack → unpack error; a valid pack over the limit → refused; hooks decline a ref or the push |

## Verified

All 8 Node tests pass (`pnpm test 22-receive-pack`). The tests were written first (red commit).
The test harness's request stream tolerates an early cancel (a handler stopping at its size limit
made Node's `Readable.toWeb` throw "Controller is already closed").

### Mutation check

| Mutation | Caught by |
|---|---|
| Q1 no connectivity check | R4 |
| Q2 atomic applied per ref | R1, R3, R7 |
| Q3 old value not compared | R3 |
| Q4 no ref-name check | R7 |
| Q5 update hook ignored | R1, R7 |
| Q6 pre-receive hook ignored | R7 |
| Q7 unpack error not reported | R4, R7 |
| Q8 no size limit | R7 (a valid pack over the limit) |
| Q9 client: no fast-forward check | R2 |
| Q10 client: not thin | R5 |
| Q11 client: atomic not requested | R7 |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/server.ts` | **Adopt** | receive-pack over a fetch handler; X5's transactions, git's checks |
| `src/client.ts` | **Adopt** | git's send-pack rules, thin packs, streamed body |

## Open threads (ranked by how much later work they would invalidate)

1. **httpeers (X8)**: mount `gitHandler` on a peer; Biscuit `authorize` per service and ref
   (`refs/peers/<id>/*`); a push longer than 30 s.
2. **Quarantine** (git's `tmp_objdir`): a refused push's objects should not enter the store; with
   X6b's resumable install the quarantine is a pack kept aside until the refs are accepted.
3. **receive.fsckObjects**: object checks on received packs (git's fsck rules) before acceptance.
4. Gitea and GitHub as oracles; report-status-v2; push certificates.
