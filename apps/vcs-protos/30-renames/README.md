# 30 — Can git's rename detection be reproduced exactly, for diff and for merge-ort?

Plan id **X13** (single diff and merge engine), slice **X13c: rename detection**. Status: **answered — yes: the port gives git's pairs, scores and order on 1,318 diffs, and on 4,000 more
from other seeds**.

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
| R5 | Hand-made cases for the mutants the corpora missed: lines the destination repeats; a basename two sources share; a fifth candidate a destination does not keep; a tie broken by the basename; binary files with CRLF inside. Added after the mutation check, see below. |

## Scope

- Copies (`-C`, `-C -C`), break detection (`-B`) and directory renames are out. So are ort's
  relevant sources and cached pairs (X13e) and `.gitattributes` (`diff`/`binary`).

## Answer

Yes. `src/renames.ts` (about 370 lines, no `node:` imports) ports `diffcore_rename_extended`, minus
copies, breaks and directory renames, together with `diffcore-delta.c`. It produces `git diff-tree -r
-M`'s output exactly on every case:
- R1: 13 hand-made cases;
- R2: 1,000 random diffs at random thresholds;
- R3: 300 random diffs with `--no-rename-empty` and rename limits of 1 to 5;
- R5: 5 cases added after the mutation check.

A separate run of 4,000 diffs from two other seeds also matched. Those diffs had 2,099 exact renames,
1,360 renames scoring 75% or more and 193 scoring below 75%.

It matches git step by step:
1. **The diff pairs.** Pairs come in path order; byte order of full paths is git's tree order. A
   type change (`T`) is neither a rename source nor a destination.
2. **Exact renames.** Sources are grouped by blob, in their order. Among sources not yet used, one
   with the destination's basename wins, otherwise the first. At most 100 candidates are tried. A
   symlink pairs only with the same mode.
3. **Basenames.** A basename unique among the remaining sources and among the remaining
   destinations is tried at a threshold half way from `-M` to 100%. With the default 50%, that is
   75%.
4. **The rename limit.** If destinations × sources is more than limit², there is no inexact pass;
   exact and basename renames stay.
5. **The matrix.** Each destination keeps its 4 best sources, replacing a slot only with a strictly
   better candidate. All slots are sorted stably by score, then by the same basename, and taken
   best first.
6. **Similarity** (`hash_chars`, `diffcore_count_changes`):
   - Chunks end at LF or after 64 bytes.
   - In text (no NUL in the first 8,000 bytes), a CR before LF is dropped.
   - The bytes after the last chunk (a file without a final LF) form a chunk of their own in newer
     git (2.56, on CI). git 2.43 drops them. `legacyHashChars` selects 2.43's rule, and the tests
     probe which one the installed git has. Modes are canonical as in `canon_mode` (`100664` is
     `100644`).
   - Chunks are hashed into 107,927 buckets with git's two 32-bit accumulators.
   - The score is the bytes copied (the smaller count per bucket) × 60,000 ÷ the larger size,
     truncated. Sizes too far apart score 0.
7. **Output.** A rename stands where its destination was, and its source's deletion goes. The
   percent is `score × 100 ÷ 60000`, truncated.

### Mutation check

| # | Mutant | Result |
|---|---|---|
| C1 | Exact renames: no same-basename preference | killed (R1) |
| C2 | Exact renames: a symlink to any mode | killed (R1, R2, R3) |
| C3 | No CR dropping in text | killed (R1, R2, R3) |
| C4 | No 64-byte chunks | killed (R1, R2, R3) |
| C5 | The bytes after the last chunk counted | killed on git 2.43 (R2, R3). This is git 2.56's rule, which CI found (see the review); both rules are now kept, and the unit test in R6 kills either mutant |
| C6 | The destination's surplus counted as copied | survived; killed by R5 |
| C7 | No size cutoff | equivalent: bytes copied are at most the smaller size, so a pair the cutoff drops scores below the threshold anyway; it only saves work |
| C8 | No basename pass | killed (R1, R3) |
| C9 | The basename pass at the plain threshold | killed (R3) |
| C10 | A basename two sources share paired | survived; killed by R5 |
| C11 | Every candidate kept, not 4 | survived; killed by R5 |
| C12 | Ties not broken by the basename | survived; killed by R5 |
| C13 | Rename limit ignored | killed (R3) |
| C14 | Empty files always renames | killed (R3) |
| C15 | Binary content treated as text | survived; killed by R5 |
| C16 | The percent rounded | killed (R1, R2, R3) |
| C17 | Similarity over the smaller size | killed (R1, R2, R3) |
| C18 | No exact pass | killed (R1, R2, R3) |

### Review (#98)

A separate review compared the port with the C line by line and ran 6,300 differential cases
against git 2.43, plus targeted ones:
- 140 identical sources and 100-candidate limits;
- CR at byte 63;
- NUL around byte 8,000;
- thresholds from 0% to 100%;
- rename limits around N×M;
- unicode paths.

Against 2.43 the only mismatch was legacy modes. CI's git 2.56 failed R2 and R3.

| Finding | Fix |
|---|---|
| git 2.56's `hash_chars` counts the bytes after a file's last LF as a chunk; the port followed 2.43 (CI: R93 against our R83) | Counted by default, `legacyHashChars` for 2.43, and the tests probe the installed git with a 35%-or-64% pair; R6 |
| Legacy modes (`100664`) were kept, so an exact rename showed `100664`, a mode-only change showed `T`, and an inexact rename was missed | `canon_mode`; R6 |
| The corpus gave 90% of files a final newline, so a 2.56-only rule hid there | 40% now lack one |
| R3 asserted no renames, and `show` cut oids to 7 characters | R3 asserts more than 50 renames, and oids are compared whole |
| Non-UTF-8 path bytes (`\xfe`, `\xff`) are decoded lossily by 17's `parseTree` and collide | Upstream in 17-repository; an open thread |

The review confirmed the rest as faithful:
- the 32-bit hash arithmetic;
- binary detection;
- `find_identical_files`' order and limit;
- the basename pass;
- `record_if_better` and `score_compare`, with a stable sort;
- `parse_rename_score`;
- output order;
- path order (`a`, `a-b`, `a.b`, `a/b`).

It also confirmed that C7 is equivalent.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/renames.ts` | **Adopt** | git's rename detection, exactly: `diff -M`, status, log --follow, and ort's renames (X13d) |

## Open threads

1. **X13d**: ort's renames in the merge. These are rename/delete, rename/rename (1 to 2 and 2 to
   1), rename/add and rename plus modify, with ort's relevant sources (only deleted files the merge
   needs) and merge-ort's settings (`rename_empty` off, limit 7,000).
2. **X13e**: directory renames (`dir_rename_count`, the basename guesses of `idx_possible_rename`)
   and criss-cross merges.
3. Copies (`-C`), break detection (`-B`), `.gitattributes` binary and diff drivers.
4. **Performance**: the matrix is N×M similarity estimates, cached by blob. git's own limit
   (1,000 for diff, 7,000 for merge) bounds it the same way. The review measured:
   - 500×500 candidates: 307 ms against git's 109 ms;
   - a 30 MB rename: 2.0 s against 0.4 s, from the Map-based span hash.

   Blobs are read whole just to learn their sizes before the size cutoff, and they stay cached for
   the whole run. `diffTrees` flattens both trees instead of skipping unchanged subtrees.
5. **Non-UTF-8 path bytes**: 17's `parseTree` decodes names lossily, so two names that differ
   only in invalid UTF-8 collide.
