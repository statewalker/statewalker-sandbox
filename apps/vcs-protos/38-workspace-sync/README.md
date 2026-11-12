# 38 — Can folders sync through git history and converge?

Plan id **X17** (workspace sync on history). Status: **open**.

## Question

webrun-sync keeps folders in step between endpoints (tabs, devices, a Durable Object). If each
endpoint records its folder as git commits and syncs by exchanging commits and merging them, edits
made in parallel merge like branches, nothing is lost, and every endpoint has the whole history.
Does that converge — every endpoint ending on the same commit and the same files — whatever the
order of edits and syncs, with conflicting edits included?

## Reject condition

Rejected if, after a final round of syncs with no new edits, two endpoints hold different commits
or files; if a non-overlapping edit is lost or reported as a conflict; or if an endpoint's history
is not a valid git repository.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| S1 | **Non-overlapping edits.** Three endpoints edit different files (adds, edits, deletes, renames, new directories) and sync pairwise in random orders: every merge is clean, and all three end with the union of the edits, on one commit. |
| S2 | **Conflicting edits.** Endpoints edit the same lines, or edit and delete one file: the merge commits the conflicted files (git's markers), reports their paths, and the endpoints still converge on one commit — whichever endpoint merged first. |
| S3 | **Property test.** 200 random schedules over three endpoints (edits, deletes, syncs interleaved): after a final round of syncs every endpoint holds the same commit and files, and every edit no other endpoint touched is in the result. |
| S4 | **Deterministic merges.** Two endpoints merging each other's heads at the same time make the identical merge commit (sorted parents, a fixed identity, the later parent's date), so syncing back is a fast-forward, not another merge. |
| S5 | **Git history.** An endpoint's repository, copied to disk, passes `git fsck --strict`, and `git log` shows each endpoint's edits. |
| S6 | **Portable.** `src/` has no `node:` imports; the endpoints run on in-memory FilesApis. |

## Scope

- Endpoints sync in one process here; the transport (X7/X8) carries the same objects and refs.
- Folders are plain files (no executable bits or symlinks, as X14 on a FilesApi).
