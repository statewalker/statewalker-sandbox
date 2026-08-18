# 05 — Mount resolution: longest prefix, on segment boundaries

`pnpm demo:05-router-mounts`

Pure logic, no network — routing is a total function of the mount table and the
path, and is clearer tested directly. **This is a reconstruction** (see
Provenance below).

## Verified

Nine cases against a table registered **shallow-first**, so "longest wins"
cannot be an artefact of ordering:

| # | Request | Resolves to | Establishes |
|---|---|---|---|
| 1 | `/files` | `/files` | Exact match |
| 2 | `/files/` | `/files` | A trailing slash does not change the answer |
| 3 | `/files/a.txt` | `/files` | Descendants route to their mount |
| 4 | `/files/public` | `/files/public` | **A deeper mount beats a shallower one** despite being registered later |
| 5 | `/files/public/x` | `/files/public` | Depth wins for descendants too |
| 6 | `/filesystem` | `/filesystem` | **A shared textual prefix does not capture a different mount** |
| 7 | `/filesystem/deep/er` | `/filesystem` | The boundary rule holds at depth |
| 8 | `/` | `/` | The root is reachable |
| 9 | `/unmatched` | `/` | The root acts as a catch-all rather than 404-ing |

Plus an explicit assertion that case 6 did not resolve to `/files` — stated
separately because it is the property most likely to regress.

Exit code is 0 only if all nine match **and** the boundary check holds.

## Why the boundary rule matters

Naive `startsWith` matching makes `/files` swallow `/filesystem`,
`/files-archive` and anything else sharing those six characters. It looks
correct in every test where mount names happen not to share prefixes, and
breaks the day someone mounts a name that does — with no error, just traffic
going to the wrong handler.

## Provenance

The archived prototype for the router (`31-httpeers-prototype-v0.6.0`) was
saved as a **delta** — only the files that version added — and the tree it
applied to no longer exists in the archive. `lib/router.ts` implements the same
rules from the recorded findings. It is not the code that passed the original
tests.

## Not covered here

- **No unmount or replace.** Whether `provide()` supports hot-reload is an open
  question in the design and is not exercised.
- **No query-string or method-based routing.** Path only.
- **Overlapping mounts at equal depth** are not disambiguated — the table here
  has no such pair, and the design does not yet say what should happen.
