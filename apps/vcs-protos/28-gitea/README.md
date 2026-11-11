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
| G1 | ✅ | Our `clone` of a repository native git pushed to Gitea: logs equal. Our `push` with Basic credentials: native `git clone` from Gitea has our log and passes `fsck --strict`. Without credentials: rejected with Gitea's 401. Smart HTTP v2 needed no change. |
| G2 | ✅ | A façade commit with `.gitattributes` and a pointer, its object sent with `lfsPush` (offering `ranged`; Gitea's answer has no `transfer` field, which means `basic`) and the commit with `vcs.push`: native `git clone` with git-lfs smudges the 3 MiB file byte-identical, and `git lfs fsck` is clean. Gitea accepted our streamed `PUT` without `Content-Length` and our `verify`. A second push sends nothing. |
| G3 | ✅ | A file native git-lfs pushed to Gitea: `lfsFetch` stores it byte-identical. A download cut after 1 MiB resumes with `Range: bytes=N-`; Gitea answers 206, and the bytes over both attempts equal the size. |
| G4 | ✅ | A missing object gives Gitea's per-object 404 (our error: not found). Bytes altered in transit from Gitea are refused, and nothing is kept. Gitea itself refuses a `PUT` whose bytes do not hash to the oid in its href. |
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
