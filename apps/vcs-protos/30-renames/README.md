# 30 — Can git's rename detection be reproduced exactly, for diff and for merge-ort?

Plan id **X13** (single diff and merge engine), slice **X13c: rename detection**. Status: **open**.

## Question

merge-ort and `git diff -M` both find renames with `diffcore-rename.c`, which uses the similarity
estimate in `diffcore-delta.c`. webrun-vcs has no rename detection; JGit's `RenameDetector` uses
other scores, other tie-breaks and no basename pass, so it pairs files differently from git. X13d
(ort's rename conflicts) needs git's pairs exactly, since every rename/delete, rename/rename and
rename/add conflict depends on which file was paired with which.

Can a portable TypeScript port of `diffcore_rename` give exactly the pairs and scores git gives? The
port covers:
- exact renames, with their tie-breaks (sources not yet used, then the same basename, then the first
  source);
- the basename pass: a unique basename on both sides, matched at the basename threshold;
- the inexact matrix, keeping the 4 best candidates per destination, with a stable sort by score and
  then by the same basename;
- the size cutoff and the rename limit;
- the span-hash similarity: chunks of up to 64 bytes ending at LF, CR dropped before LF in text,
  hashed modulo 107927.

Directory renames and ort's relevant-source pruning are X13e.

## Reject condition

Rejected if, on any case of the corpus, the port's list of changes differs from
`git diff-tree -r -M --raw -z`: a status, a score, a path, a mode, an oid, or the order of the list.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Hand-made cases, identical to `git diff-tree -r -M`: an exact rename; several identical sources (the tie-breaks); an exact symlink rename, and a symlink that changes mode; an edit just above and just below 50%; a unique basename beating a better candidate with another name; sizes too far apart; binary files; CRLF against LF; lines longer than 64 bytes; empty files; a type change, which is neither a source nor a destination. |
| R2 | 1000 random tree diffs: moves with and without edits, across directories and within one, duplicated content, shared basenames, random thresholds (`-M<n>%`). The output is equal to git's. |
| R3 | merge-ort's settings: `--no-rename-empty`, and rename limits small enough to cut off the inexact pass while exact renames still happen (`-l<n>`). Equal to git's on 300 random diffs. |
| R4 | Portable: `src/` has no `node:` imports. |

## Scope

- Copies (`-C`, `-C -C`), break detection (`-B`) and directory renames are out. So are ort's
  relevant sources and cached pairs (X13e) and `.gitattributes` (`diff`/`binary`).
