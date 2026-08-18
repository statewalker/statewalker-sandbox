# 07 — `.access` walked root → leaf, deny by default

`pnpm demo:07-access-tree`

Pure logic, no network — policy resolution is a total function of the tree and
the caller. **This is a reconstruction** (see Provenance).

## Verified

Seven decisions against a five-node tree, with two callers in mesh `H` and one
in mesh `G`:

| # | Caller | Path | Result | Establishes |
|---|---|---|---|---|
| 1 | alice (`std:reader`) | `/pub/logo.png` | **allow** at `/pub` | A grant with **empty roles** means "any member of the mesh" |
| 2 | alice | `/reports/q3` | **allow** at `/reports` | A role-scoped grant applies to descendants |
| 3 | alice | `/reports/private/notes` | **deny** at `/reports/private` | **An explicit deny overrides an inherited allow** |
| 4 | alice | `/reports/private/board/minutes` | **deny** at `/reports/private` | The deny keeps applying deeper when nothing re-grants for her |
| 5 | root (`std:reader`,`std:admin`) | `/reports/private/board/minutes` | **allow** at `/reports/private/board` | **A deeper allow overrides a shallower deny** — late override, not first-match |
| 6 | outsider (`std:admin` **in mesh G**) | `/pub/logo.png` | **deny** at root default | **Holding a role in another mesh buys nothing.** Vocabulary is global; *trust* is per-resource |
| 7 | alice | `/unlisted` | **deny** at root default | An unmentioned path is denied, not defaulted open |

Plus two structural properties:

| # | Claim | How it is established |
|---|---|---|
| 8 | Every decision is **explainable** | Each carries `decidedAt` and `reason`; the demo prints the full walk for case 4, showing which node denied and which nodes were inherited through |
| 9 | A malformed tree **refuses to start**, listing *every* problem | `withAccessTree([{path:"pub",…}])` throws, reporting both the missing leading slash **and** the absent root policy — not just the first fault |

Exit code is 0 only if all seven decisions match and the malformed tree throws.

## Why deny-by-default is placed at the root

A policy that denies everyone because of a typo is indistinguishable at runtime
from one that works correctly. That is why claim 9 exists: the failure is made
loud and early, at construction, with a complete list — rather than surfacing
later as "nobody can reach anything" with no clue why.

Claim 6 is the one that keeps standard roles safe. Because the role →
capability mapping is global and mesh-independent, it would be a serious flaw
if a global mapping also made *trust* global — any mesh could mint `std:admin`
and gain admin everywhere. It cannot, because the `.access` policy names
`{ mesh, roles }` per resource.

## Provenance

The archived prototype (`33-httpeers-prototype-v0.7.0`) was saved as a
**delta**; the tree it applied to no longer exists in the archive.
`lib/access-tree.ts` implements the same rules from the recorded findings.

## Not covered here

- **No file loading.** The real design walks `.access` files through the
  `webrun-files` API so the same code runs over OPFS in a browser and disk on a
  server. This tree is in memory. Notably, **the loader is unbuilt** in the real
  design too, and a malformed file must fail closed.
- **No token.** The caller's `{ mesh, roles }` is supplied directly rather than
  extracted from a verified JWT.
- **No capability layer** — that is 09.
