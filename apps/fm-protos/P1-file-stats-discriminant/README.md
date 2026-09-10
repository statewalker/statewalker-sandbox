# P1-file-stats-discriminant — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P1-file-stats-discriminant/`._

---

<!-- source: 01-P1 rung record and code.md -->

# P1 — FileStats discriminant · rung record

_9 September 2026 · green: 25/25 total (8 new) · mutations killed: 4/4_

## Verdict

The union holds, but **one clause of file 11 §1 needs correcting** (below).
Promotion grade: **Adopt** for `Stats`, `sizeCell` and `compareEntries`;
`narrowStats` is a **migration shim** that disappears when the type flip lands
upstream, so grade it **Source**.

## The correction: directory extras are dropped, not rejected

The conformance case failed on the very first adapter tested.
`MemFilesApi@0.7.2` reports `lastModified` on **directories**. File 11 §1 says
the directory variant is exactly `{ kind: "directory" }`, which would make mem
non-conformant.

That reading is wrong, and the fix is one sentence of policy:

- Requiring the absence of a directory mtime would force adapters to **hide**
  information they legitimately have (mem and node both track it).
- Requiring its presence would reinstate exactly the **per-adapter capability
  table** the design rejected, since S3 cannot report one.

So: **the union defines what a consumer may rely on, and narrowing is the
barrier that enforces it.** `narrowStats` drops directory extras rather than
throwing. A conformance violation is only ever a *file* missing `size` or
`lastModified` — that stays a hard failure, because it is the one case where
the adapter is claiming less than it must.

A useful consequence, verified by test: an adapter that **synthesises** a
directory size (`size: 0`) cannot leak it into a row — the narrowing boundary
blanks the cell. Values are never synthesised, and now never propagated either.

## Acceptance criteria, as tested

Per-adapter conformance (parameterised, ready to move into
`webrun-files-tests`):

1. A file narrows to the file variant with numeric `size` and `lastModified`.
2. A directory narrows to exactly `{ kind: "directory" }`, extras dropped.
3. **A zero-byte file is the file variant with `size: 0`** — the falsy trap
   that a truthiness check would misread as a directory. This is the case that
   forces the S3 marker-object decision.
4. Every entry of a `list()` narrows without throwing.

Teeth of the suite:

5. An adapter reporting a file with no size fails loudly.
6. A synthesised directory size never reaches a row.

Consequences for the panel:

7. A directory renders a blank size cell; `size: 0` renders `"0"`, not blank.
8. Sorting **groups directories separately** in every column instead of being
   disabled — name, size and date each order directories by name first, then
   files by the column.

## Mutations run

| # | Mutation | Killed |
| --- | --- | --- |
| M1 | file variant accepts a missing `size` | yes |
| M2 | directory extras passed through instead of dropped | yes |
| M3 | directories no longer grouped ahead of files when sorting | yes |
| M4 | `sizeCell` renders `0` for directories | yes (2 cases) |

## Still open upstream

The type flip itself is not landed — `@statewalker/webrun-files@0.7.0` still
declares `FileStats { kind; size?; lastModified? }` with `kind` as a field. The
sequence from file 14 stands: conformance case first (done here, portable as
written), then flip the type, then delete `narrowStats`.

## Code

### `src/core/file-stats.ts`

```ts
import type { FileStats } from "@statewalker/webrun-files";

/**
 * P1 — the proposed upstream shape of `FileStats`.
 *
 * Size and time are not available for DIRECTORIES, but are always available
 * for FILES. Making `kind` a discriminant instead of a field removes the
 * option of letting `undefined` fudge the difference — which is exactly what
 * forces S3 to decide whether a common prefix is a directory and whether a
 * zero-byte marker object is a file with `size: 0`.
 */
export type Stats =
  | { kind: "file"; size: number; lastModified: number }
  | { kind: "directory" };

/**
 * Migration shim standing in for the type flip. Once the union lands upstream
 * this disappears; until then it enforces at runtime what the type will
 * enforce at compile time, so the conformance suite can run first.
 */
export function narrowStats(stats: FileStats | Stats): Stats {
  if (stats.kind === "directory") {
    // Extras are DROPPED, not rejected. Some adapters (mem, node) can report a
    // directory mtime and others (S3) cannot; requiring its absence would make
    // adapters hide information, and requiring its presence would reinstate the
    // per-adapter capability table this design rejected. The union says what a
    // consumer may rely on, and narrowing is the barrier that enforces it.
    return { kind: "directory" };
  }
  const { size, lastModified } = stats as { size?: number; lastModified?: number };
  if (typeof size !== "number" || typeof lastModified !== "number") {
    throw new Error("not the file variant: size and lastModified are required on files");
  }
  return { kind: "file", size, lastModified };
}

/** A directory shows a blank size cell, as every commander does. */
export function sizeCell(stats: Stats): string {
  return stats.kind === "directory" ? "" : String(stats.size);
}

/** Directories sort as a separate group, ahead of files, in every column. */
export function compareEntries(
  column: "name" | "size" | "date",
): (a: { name: string; stats: Stats }, b: { name: string; stats: Stats }) => number {
  return (a, b) => {
    const ad = a.stats.kind === "directory" ? 0 : 1;
    const bd = b.stats.kind === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (a.stats.kind === "directory" || b.stats.kind === "directory") {
      return a.name.localeCompare(b.name);
    }
    if (column === "size") return a.stats.size - b.stats.size;
    if (column === "date") return a.stats.lastModified - b.stats.lastModified;
    return a.name.localeCompare(b.name);
  };
}
```

The conformance suite is `test/p1-file-stats.test.ts`, parameterised by a
`make()` factory so it can be lifted into `webrun-files-tests` unchanged, with
`LyingFilesApi` and `InventingFilesApi` as the negative fixtures.

