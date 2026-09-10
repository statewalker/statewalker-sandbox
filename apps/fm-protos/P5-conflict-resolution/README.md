# P5-conflict-resolution — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P5-conflict-resolution/`._

---

<!-- source: 01-P5 rung record and code.md -->

# P5 — Conflict resolution · rung record

_9 September 2026 · green: 66/66 total (8 new) · mutations killed: 6/6_

## Verdict

The callback-on-the-spec design is right and `fm-core` stays UI-free. Promotion
grade: **Adopt**. But this rung produced **three corrections**, one of them a
boundary violation that had been sitting in the tree since P0.

## Correction 1 — `ui:show-job` was declared in `fm-core`

The suite includes a grep test: no file under `src/core` may name `ui:` or
import from `../app`. It failed immediately on `src/core/declarations.ts`, where
P0 had put `uiShowJob` next to `filesCopy` because both concern jobs.

They are not the same layer. `files:*` is core vocabulary; `ui:*` is app
vocabulary, and the whole point of the conflict callback is that core can run
with no UI at all. The declaration moved to `src/app/declarations.ts`, which
imports `JobModel` as a type from core — the dependency direction the package
table in file 07 requires.

**A boundary you do not grep is a boundary you do not have.** This test is
cheap and should be lifted to CI as-is.

## Correction 2 — decisions must be serialised, or `applyToAll` is useless

The first implementation read `conflicts.applyToAll` per entry and cached the
answer when it arrived. With `batchSize: 4`, all four entries checked the cache
**before** the first answer landed, so the user was asked four times for the
same question. The test asked for 1 and got 4.

The fix is one in-flight decision per job: a second conflict in the same batch
waits on the pending promise and then re-reads `applyToAll`. Without it,
"apply to all remaining" silently degrades to "apply to all remaining, minus
the rest of this batch" — and the larger the batch, the worse it looks.

Worth adding to file 05 §7: **`applyToAll` and parallel batches interact, and
the resolver must be serialised.**

## Correction 3 — an aborted decision is cancellation, not failure

A resolver rejecting because the job was cancelled propagated to the outer catch
and settled the job as `failed`, with the rejection text as its error. The user
pressed Escape and got a scary error. The engine now checks
`job.signal.aborted` first and settles as `cancelled`.

## Acceptance criteria, as tested

1. Only genuinely conflicting entries are asked about — a new file is never
   raised as a conflict.
2. `overwrite`, `skip` and `rename` are each honoured per entry.
3. `rename` writes `a (2).txt` and leaves the existing `a.txt` untouched.
4. **50 conflicts with `applyToAll` ask exactly once.**
5. A plain `conflictPolicy` covers the case where no callback is supplied.
6. Cancelling with a decision pending aborts it through the job's signal, the
   job ends `cancelled`, and the target file is untouched.
7. Skipped entries are recorded as job errors; the job still ends `done`.
8. **`src/core` names no `ui:` command and imports nothing from `../app`.**

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | `applyToAll` not cached | 1 |
| M2 | decisions not serialised (parallel asks) | 1 |
| M3 | conflicts never detected (blind overwrite) | 7 |
| M4 | `rename` overwrites anyway | 1 |
| M5 | aborted decision reported as failure | 1 |
| M6 | `skip` copies anyway | 4 |

## Code — the P5 additions to `src/core/copy-job.ts`

```ts
export interface ConflictResolution {
  resolution: "overwrite" | "skip" | "rename";
  applyToAll: boolean;
}
```

```ts
  /**
   * Injected as a callback on the SPEC, never as a UI dependency: fm-core must
   * be usable with no `ui:*` vocabulary anywhere in it. The app layer passes a
   * resolver that goes through its dialog mechanism, a test passes a constant,
   * an agent passes its own policy.
   */
  onConflict?(entry: { path: string; target: string }, signal: AbortSignal): Promise<ConflictResolution>;
  /** Used when no callback is supplied, so the simple case needs nothing. */
  conflictPolicy?: "overwrite" | "skip" | "rename";
```

```ts
  // Conflict detection is exists() then write(): a TOCTOU race, since FilesApi
  // has no exclusive create. Accepted for now; the `.part` + move() protocol
  // closes it later as an opt-in mode.
  if (await target.api.exists(to)) {
    const decision =
      conflicts.applyToAll ??
      (spec.onConflict
        ? await resolveConflict(spec, entry, to, conflicts)
        : (spec.conflictPolicy ?? "overwrite"));
    if (decision === "skip") {
      errors.push({ path: entry.path, reason: "skipped" });
      job.skipped.push(entry.path);
      return;
    }
    if (decision === "rename") to = rename(to);
  }
```

```ts
interface Conflicts {
  applyToAll?: ConflictResolution["resolution"];
  pending?: Promise<unknown>;
}

/**
 * The resolver is interruptible by the job's AbortSignal, and only ONE
 * decision is in flight at a time — a second conflict in the same batch waits
 * for the first answer and then re-reads `applyToAll`.
 */
async function resolveConflict(
  spec: JobSpec, entry: Entry, to: string, conflicts: Conflicts,
): Promise<ConflictResolution["resolution"]> {
  while (conflicts.pending) {
    await conflicts.pending.catch(() => undefined);
    if (conflicts.applyToAll) return conflicts.applyToAll;
  }
  const ask = spec.onConflict!({ path: entry.path, target: to }, spec.job.signal);
  conflicts.pending = ask;
  try {
    const answer = await ask;
    if (answer.applyToAll) conflicts.applyToAll = answer.resolution;
    return answer.resolution;
  } finally {
    conflicts.pending = undefined;
  }
}

function rename(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)} (2)${path.slice(dot)}` : `${path} (2)`;
}
```

```ts
    // An aborted decision is cancellation, not failure: the resolver rejects
    // because the job was cancelled, and reporting that as a failure would put
    // a scary error in front of a user who simply pressed Escape.
    if (job.signal.aborted) return job.settle("cancelled");
    job.settle("failed", String((err as Error).message ?? err));
```

Suite: `test/p5-conflicts.test.ts`. The layering test reads `src/core/*.ts` from
disk, strips comments, and asserts no `ui:` reference — so the boundary is
checked as a fact about the files, not as an intention.

## Unchanged and still accepted

The TOCTOU race in `exists()` → `write()`. `FilesApi` has no exclusive create,
so it cannot be closed here; the `.part` + `move()` opt-in closes it later, as
file 05 §2 says.

