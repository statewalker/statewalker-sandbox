# 28 — Do our git and LFS clients work against Gitea, a production server?

Plan id **X10** (LFS, "Gitea-verified") and **X0** (Gitea as an oracle), slice **X10b**. Status:
**answered — yes, after one fix: transfer headers merged by name**.

## Question

X8a/X8b (smart HTTP v2 fetch and push) and X10a/X12 (LFS batch, basic and ranged transfers) were
checked against native git, `git http-backend` and git-lfs, with our own servers. A production
forge implements the same protocols with its own choices: authentication, URL shapes (Gitea's
upload hrefs carry the size), its batch answers (no `transfer` field), and its handling of
streamed bodies and ranges. Do our clients interoperate with Gitea, both ways with native git and
git-lfs, and does what we push come out identical through native tools?

## Reject condition

Rejected if our client cannot fetch from, clone from or push to Gitea, if an LFS object we upload
cannot be cloned natively from Gitea (or vice versa), if a resumed download from Gitea re-sends
held bytes, or if an object is accepted unverified.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| G1 | **git over smart HTTP v2.** Our `clone` from a Gitea repository that native git pushed: logs equal. Our `push` (Basic credentials) to Gitea: native `git clone` from Gitea has the same log and passes `fsck --strict`. A push without credentials is refused (401 surfaced as an error). |
| G2 | **Our LFS upload, native clone.** A façade commit with a pointer and `.gitattributes`, its object uploaded with `lfsPush` (offering `ranged`, Gitea answers `basic`) and the commit pushed with `vcs.push`: native `git clone` (git-lfs) from Gitea smudges the file byte-identical; `git lfs fsck` clean. A second `lfsPush` sends nothing. |
| G3 | **Native LFS upload, our download.** Files pushed by native git-lfs to Gitea: `lfsFetch` stores them byte-identical. A download cut part-way resumes with `Range` and Gitea answers 206: the bytes over both attempts equal the size. |
| G4 | **Verification and errors.** A batch for a missing object gives the per-object 404 (our error says not found). Bytes altered in transit from Gitea are refused, nothing kept. Uploading bytes that do not match their oid to Gitea is refused by Gitea. |
| G5 | **Many sources.** One object held by Gitea and by one of our peers' servers: `lfsFetchFrom` takes chunks from both. |

## Scope

- Gitea 1.22.6 (linux-amd64), downloaded and checked against its published SHA-256, run headless
  with SQLite as an unprivileged user; the tests start one instance per file.
- Gitea's locking API, its SSH transport, and other forges (GitHub, GitLab) are out of scope.

## Answer

Yes, with one bug found and fixed. Gitea's LFS actions carry `Authorization` (capital A) and our
client added its own `authorization` as a second object key. `fetch` then sent the two as one
header, `Basic …, Basic …`, and Gitea answered 401 to every transfer. Our own server had never
shown this, because its actions use lower-case names. `transferHeaders` now merges by name,
case-insensitively, and the action's value wins. A test in 26 keeps the case without Gitea.

| # | Result | How |
|---|---|---|
| G1 | ✅ | Our `clone` (protocol v2: Gitea advertises `ls-refs=unborn`, `fetch=shallow wait-for-done filter`) of a private repository native git pushed: logs equal. Our `push` (receive-pack, which has no v2) with Basic credentials: native `git clone` from Gitea has our log and passes `fsck --strict`. Without credentials: `HTTP 401`. |
| G2 | ✅ | A façade commit with `.gitattributes` and a pointer, its object sent with `lfsPush` (offering `ranged`; Gitea's answer has no `transfer` field, which means `basic`) and the commit with `vcs.push`: native `git clone` with git-lfs smudges the 3 MiB file byte-identical, and `git lfs fsck` is clean. Gitea accepts our streamed `PUT` without `Content-Length` by design: it checks the size and hash of a chunked body (a short one is refused with 422). Our client calls Gitea's `verify` action, though it only checks that the object exists, not its size. A second push sends nothing. |
| G3 | ✅ | A file native git-lfs pushed to a private Gitea repository: without credentials, the batch is 401; with them, `lfsFetch` stores it byte-identical. A download cut after 1 MiB resumes with `Range: bytes=N-`; Gitea answers 206, and the bytes over both attempts equal the size. Gitea 1.22 reports the total in `Content-Range` as size − start (`bytes 1048576-4194303/3145728`), so the client must read only the start; the test pins this. |
| G4 | ✅ | A missing object gives Gitea's per-object 404 (our error: not found). Bytes altered in transit from Gitea are refused, and nothing is kept. Gitea itself refuses a `PUT` whose bytes do not hash to the oid in its href with 422 ("content hash does not match OID"), and the object stays absent. |
| G5 | ✅ | One object held by Gitea and by one of our peers' servers (`ranged`): `lfsFetchFrom` takes 512 KiB chunks from both (Gitea serves single ranges), exactly the size in total. |

### Running Gitea

`tests/gitea.ts` covers all of it:
- downloads `gitea-1.22.6-linux-amd64` once, or takes `GITEA_BIN`, and checks the published
  SHA-256 before every use;
- writes an `app.ini` with SQLite, LFS on, offline mode, a free port and registration off;
- runs `migrate`, creates an admin user, starts `gitea web`, and creates repositories through the
  API.

Gitea refuses to run as root. As root (this sandbox), the helper runs it as `nobody` with
`runuser`, owning its work directory; as an ordinary user (CI), it runs directly. Its root
override is not used. One instance per test file, stopped and removed afterwards.

### Review (#92)

A separate review found 9 points (6 reproduced by running code). The `transferHeaders` change itself was clean. All are fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | As root, `stop()` killed `runuser` after 300 ms and left Gitea running (reparented) while its directory was removed | Gitea runs in its own process group; stop sends SIGTERM to the group, waits for the exit up to 10 s, then SIGKILL; removal retries |
| 2 | Parallel runs raced on one shared download file: 3 of 4 failed | Each writer downloads to its own name and renames it into place; a failed writer re-checks whether the binary is now valid (12 of 12 parallel runs succeed) |
| 3 | A failed start left its work directory and hid Gitea's log; a death by signal waited the full minute | The start cleans up on any failure, includes the log's tail in the error, and watches `signalCode` too |
| 4 | G4 accepted any status ≥ 400 (a 401 would pass) | Exactly 422, and the object then absent |
| 5 | G1's `/401/` could match the random port | `/HTTP 401\b/` |
| 6 | Public repositories: downloads never exercised credentials; `verify` was claimed, not asserted; Gitea's `Content-Range` total was undocumented | Repositories are private (an anonymous batch is 401); `verify` is counted; the `Content-Range` total is pinned and documented |
| 7 | A 143 MB download on every CI run; a copy from `GITEA_BIN` kept its source's owner | `actions/cache` keyed on the version (`GITEA_CACHE_DIR`); the copy is chowned to the current user |
| 8 | A port taken between choosing it and Gitea binding it | The probe checks Gitea's version in the answer; a failed start is retried on another port |
| 9 | `lfsBatch` still spread the caller's headers as object keys | Merged by name, as `transferHeaders`; a test in 26 |

### Mutation check

The bug itself was the mutant. Merging the headers as object keys again fails G2, G3, G4 and G5
here, and 26's new test without Gitea.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/gitea.ts` | **Adopt** (test infrastructure) | the plan's X0 Gitea oracle without Docker: pinned, verified, unprivileged |
| 26's `transferHeaders` fix | **Adopt** | case-insensitive header merge, found by a production server |

## Open threads

1. **More forges**: GitHub and GitLab (LFS with redirects to object storage; their batch answers
   carry `expires_at`), and Hugging Face (Xet, X11).
2. **Gitea's locking API** (`locks`, `locks/verify`) against our client once it speaks it.
3. **CI cost**: a 143 MB download per run without a cache; a cache key on the version would avoid it.
