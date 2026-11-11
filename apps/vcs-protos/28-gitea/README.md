# 28 — Do our git and LFS clients work against Gitea, a production server?

Plan id **X10** (LFS, "Gitea-verified") and **X0** (Gitea as an oracle), slice **X10b**. Status:
**open**.

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
