# C1-model-kit — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C1-model-kit/`._

---

<!-- source: 01-C1 rung record and code.md -->

# C1 — The model kit · rung record

_9 September 2026 · green: 96/96 · the kit is red-tested against broken fixtures_

## Verdict

The kit exists, fails what it should fail, and `PanelModel` is now held to it
retroactively. Promotion grade: **Adopt**. Every model built from C2 onward
runs all three helpers.

## Why this rung exists

P0/M4 survived its first mutation pass: replacing `entries = buffer` with an
in-place `push` broke nothing, because `push()` + `notify()` is invisible to an
`onChange` watcher of `() => model.entries`. Every level field holding an array
or object carries that hazard, and file 14's original plan audited it at P9 —
*after* the panel and listing models had been written against it.

File 16 inverted the order. This is the result: three helpers that constrain
models as they are written, rather than a rung that inspects them afterwards.

## The helpers

- **`probe(model, selector)`** — counts strict-equality changes, not notifies.
- **`expectReplacedNotMutated(model, selector, write)`** — the write must be
  observable. Fails with the actual diagnosis, not a bare assertion:
  *"level field was mutated in place: `push()`/`splice()` + notify() is
  invisible to an onChange watcher. Replace the value instead."*
- **`expectNoSelfWake(input, outer, reactions, write)`** — writes to the outer
  model must not trigger a reaction subscribed to `input`.
- **`expectEdgeCounter(input, field, observe)`** — two increments in one tick
  must both be observed; a boolean field is rejected outright by type.

## The kit is red-tested before it is trusted

A test helper that cannot fail is worse than none, because it reports safety it
never checked. So each helper has a **deliberately broken fixture** it must
reject and a correct one it must accept:

| Helper | Broken fixture | Correct fixture |
| --- | --- | --- |
| `expectReplacedNotMutated` | `items.push(v); notify()` | `items = [...items, v]` |
| `expectNoSelfWake` | reaction subscribed to the outer model | reaction subscribed to `input` |
| `expectEdgeCounter` | a boolean `submitted` | a counter vs a `_handled` watermark |
| `expectEdgeCounter` | counter whose observer counts pulses, not deltas | observer comparing against the watermark |
| `probe` | — | fires on change, not on bare `notify()` |

The fourth row is the subtle one: a **counter** is not sufficient on its own.
An observer that increments once per notify still collapses two edges in a
tick. The helper tests the observer as much as the field.

## Applied retroactively to `PanelModel`

`packages/fm-app/test/c1-panel-model-conformance.test.ts` runs the kit against
the tree's first model: `entries` is replaced not mutated, the controller
cannot be woken by its own writes, and `input` is the only writable surface
(no `commands`, no `api` on the model).

## Mutation

`C1-M1` — make `probe` fire on every notify rather than on change: 2 tests
fail. Without it, `expectReplacedNotMutated` would pass an in-place mutation,
which is precisely the failure it exists to prevent.

## Code

### `packages/fm-app/src/model-kit.ts`

```ts
import { BaseClass, onChange } from "@statewalker/shared-baseclass";

export interface Probe {
  readonly count: number;
  stop(): void;
}

/** Watches one selector for strict-equality change. */
export function probe<T>(model: BaseClass, selector: () => T): Probe {
  let count = 0;
  const off = onChange(
    (cb: () => void) => model.onUpdate(cb),
    () => count++,
    selector,
  );
  return { get count() { return count; }, stop: off };
}

/**
 * Asserts that a level field is REPLACED rather than mutated: the watcher must
 * observe the change. Pass the write you expect the controller to perform.
 */
export async function expectReplacedNotMutated<T>(
  model: BaseClass,
  selector: () => T,
  write: () => void | Promise<void>,
): Promise<void> {
  const watcher = probe(model, selector);
  await write();
  watcher.stop();
  if (watcher.count === 0) {
    throw new Error(
      "level field was mutated in place: `push()`/`splice()` + notify() is invisible " +
        "to an onChange watcher. Replace the value instead.",
    );
  }
}

/**
 * Asserts a controller cannot wake itself: writes to the OUTER model must not
 * trigger the reaction that is subscribed to `input`.
 */
export async function expectNoSelfWake(
  input: BaseClass,
  outer: BaseClass,
  reactions: () => number,
  write: () => void | Promise<void>,
): Promise<void> {
  const before = reactions();
  await write();
  outer.notify();
  if (reactions() !== before) {
    throw new Error(
      "controller reacted to its own write: the reaction must be subscribed to " +
        "`input`, not to the outer model it writes.",
    );
  }
}

/**
 * Asserts a field is edge-shaped: two increments in one tick are both
 * observed. A boolean `submitted` cannot express two clicks in one tick.
 */
export function expectEdgeCounter(
  input: BaseClass & Record<string, unknown>,
  field: string,
  observe: () => number,
): void {
  const start = observe();
  const value = input[field];
  if (typeof value !== "number") {
    throw new Error(`${field} must be a monotonic counter, not ${typeof value}`);
  }
  input[field] = (value as number) + 1;
  input[field] = (value as number) + 2;
  input.notify();
  if (observe() - start < 2) {
    throw new Error(
      `${field} lost an edge: two increments in one tick must both be observed ` +
        "(compare against a handled watermark, not a boolean).",
    );
  }
}
```

Suites (archived alongside): `c1-model-kit.test.ts` — the broken/correct fixture
pairs; `c1-panel-model-conformance.test.ts` — the kit applied to `PanelModel`.

## Next

**C2 — panel set algebra**, built with this kit from the first line, with
removal tested at the head, middle **and** tail of the ring per the symmetry
rule in file 16 §2.6.

