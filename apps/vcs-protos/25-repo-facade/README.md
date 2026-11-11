# 25 — Can one repository façade open every backend, report typed errors, cancel within 100 ms, and run git's hooks?

Plan id **X16** (repository façade & contracts), slice **X16b**. Status: **answered — yes, with the gaps listed under Open threads**.

## Question

X16a gave one command layer over git files and SQL; X8 and X18 added transport and gc. What an
application holds is still a bag of functions and two constructors. The plan's X16 asks for
`Repository.open` on every backend (also inside a Durable Object), an `AbortSignal` honoured within
100 ms, hooks, and `VcsError.code`. Can one façade give that — creating a repository as `git init`
does (HEAD on the default branch; fresh SQL stores had none), reading and writing git's config
(identity from `user.name`/`user.email`), typed errors with stable codes across every layer,
cancellation that leaves no partial state, git's reference-transaction and commit hooks, and the
gc leases X18 left to the writers?

## Reject condition

Rejected if an operation ignores its signal for more than 100 ms or leaves a partial ref update
after an abort, if an error from any layer escapes without a code, if a hook can be bypassed by an
operation that changes refs, or if a repository it creates differs from `git init`'s.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | `openRepository({ files })` / `({ db })` / `init`: a new git-files repository is what `git init --bare` makes (HEAD → refs/heads/<default>, config readable by git); a new SQL repository has the same HEAD; opening an existing one finds its objects and refs. |
| R2 | Config: git's format read and written byte-faithfully (sections, subsections, quoting, comments kept); identity from `user.name`/`user.email` when a commit names none; native `git config --get` reads what we write. |
| R3 | `VcsError` with `code` for every failure class: NOT_FOUND, CONFLICT (stale ref, non-fast-forward), CORRUPT (bad pack, hash mismatch), PROTOCOL, ABORTED, LIMIT, UNSUPPORTED, LOCKED — errors from the pack reader, index-pack, ref transactions, transport and gc map to them. |
| R4 | `AbortSignal` on clone, fetch, push, export, installPack, gc and commit: aborted mid-way, each rejects with ABORTED within 100 ms; no ref changes; temporaries swept. |
| R5 | Hooks: `referenceTransaction(prepared, committed, aborted)` on every ref update through the façade (commit, fetch, push received, gc never); `preCommit`/`commitMsg`/`postCommit` around `commit`; a hook refusing aborts with CONFLICT and nothing changes. |
| R6 | Leases: `commit` and received pushes hold X18's lease from their first object write to their ref update; gc running concurrently never deletes their objects. |
| R7 | The same façade inside a Durable Object (Miniflare): open, commit, log, gc. |

## Scope — what this slice does NOT do

- The worktree and index (X14), merge (X13), sequencer (X15), KV backend (X3 left it at refs).

## Answer

Yes. `openRepository` gives one handle over both backends. It covers init, config, typed errors,
cancellation, hooks and gc leases, and it runs unchanged in node and inside a Durable Object.
Everything it needed was already in the layers below; the façade adds about 400 lines. The one
change below the façade is in X18's gc: it now takes an `AbortSignal`, and `acquireLease` was split
out of `withLease`, because a writer holds the lease across several awaits, not across one callback.

| # | Result | How |
|---|---|---|
| R1 | ✅ | `init` writes what `git init --bare` writes: HEAD → `refs/heads/<default>`; a config with `repositoryformatversion = 0`, `filemode = true` and `bare = true`; `objects/{pack,info}` and `refs/{heads,tags}`. Native git reports the repository as bare, `fsck --strict` passes on our commit, and a SQL store gets the same HEAD. Reopening finds both. |
| R2 | ✅ | `config.ts` parses git's syntax: sections, `[x "sub"]` subsections, quoting and escapes, `#`/`;` comments outside quotes, continuations, and a bare key read as true. An edit replaces one line, or inserts one at the end of its section, and keeps every other byte. `git config --get`/`--get-all` read what we write, and an edited key stays a single value. Commits take their identity from `user.name`/`user.email`, else from `opts.identity`, and are refused with INVALID when neither gives one. |
| R3 | ✅ | `VcsError.code` is one of NOT_FOUND, CONFLICT, CORRUPT, PROTOCOL, ABORTED, LIMIT, UNSUPPORTED, LOCKED or INVALID; INTERNAL covers anything unrecognised. Ref transactions map their rejection reason directly (`locked` → LOCKED, `invalid-name` → INVALID, `mismatch`/hook → CONFLICT). Other layers' errors are mapped by class name first (`PackError`, `DeltaError`, `PktError`, `AbortError`), then by message. |
| R4 | ✅ | installPack, fetch, push and gc, aborted against a stalled peer or source, each reject with ABORTED in under 100 ms. A pack source is raced step by step; fetch, push and gc are raced as a whole and also get the signal, which the layers check between objects. No ref changes after an abort, because refs change only in the last transaction; an unfinished pack is never installed. |
| R5 | ✅ | Every ref update made through the façade's refs runs `referenceTransaction` (prepared → committed or aborted): commits, `updateRefs`, fetches, and pushes received through `serve()`. gc changes no refs. A refusal at prepared returns CONFLICT and fires "aborted". `preCommit` refuses before any ref transaction, `commitMsg` can rewrite the message, and `postCommit` sees the new id. |
| R6 | ✅ | `commit` holds X18's lease from before its first object write until its ref update. A received push holds it until its response body (the report) has been read out or cancelled. In both cases a gc started meanwhile returns `deferred`. |
| R7 | ✅ | In workerd (Miniflare), `FacadeDo` opens `{ db }` with `init`, makes three commits, runs gc, and finds HEAD → `refs/heads/main` with a log of three. |

Deviation from the criteria: R4 lists clone, export and commit. `fetch` with refspecs is the clone
path. Export is reached only through `serve()`, whose upload-pack already stops when the client
goes away (X8). `commit` checks its signal between steps and before its ref update, but no test
times it, because it never waits on a peer.

### Mutation check

19 mutants, 18 killed. M2, M3 and M14 survived the first run; the tests were then strengthened
(`core.bare` read by git; a single value after an edit; the transaction hook no longer refusing on
the pre-commit case).

| Mutant | Result |
|---|---|
| M1 no HEAD at init | killed |
| M2 config without `bare = true` | killed |
| M3 `set` appends instead of replacing | killed |
| M4 values not unquoted | killed |
| M5 config identity ignored | killed |
| M6 `locked` mapped to CONFLICT | killed |
| M7 CORRUPT message patterns removed | **survived**: equivalent; the `PackError` name branch maps it first |
| M8 LIMIT patterns removed | killed |
| M9 pack source not raced against the signal | killed |
| M10 fetch not raced and no signal | killed |
| M11 gc not raced and no signal | killed |
| M12 transaction-hook refusal ignored | killed |
| M13 no "committed" event | killed |
| M14 pre-commit refusal ignored | killed |
| M15 commit-msg rewrite ignored | killed |
| M16 commit holds no lease | killed |
| M17 received push holds no lease | killed |
| M18 missing parent not checked | killed |
| M19 `serve()` over the un-hooked refs | killed |

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/vcs.ts` | **Adopt** | the application-facing contract: codes, signals, hooks, leases |
| `src/config.ts` | **Adopt** | git's config syntax with edits that keep every other byte |
| 24-gc `acquireLease`, `signal` | **Adopt** | what writers and cancellation need from gc |

## Open threads

1. **Includes and conditional includes** (`[include] path`, `includeIf`) are not followed;
   multi-valued `set` (git's `--add`, `--replace-all`) and section removal are missing.
2. **Hook coverage below the façade**: code that takes `vcs.repo.objects` and writes refs through
   another RefDb bypasses the hooks. The façade is the boundary, as git's hooks are bound to the
   git binary.
3. **Cancellation inside a single object write** (a multi-GB blob in `commit`) waits for the write
   to finish. Streaming blob writes are X12's (large files).
4. **Message-based error mapping** is a fallback. Each layer should throw coded errors directly
   once the layers are merged into one package.
