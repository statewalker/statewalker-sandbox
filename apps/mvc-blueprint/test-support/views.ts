import type { Commands } from "@statewalker/shared-commands";
import { uiShowList } from "@todo/app/models";
import type { ViewAdapter } from "@todo/ui";

/**
 * The honest precondition every real app has, now that `ListController`
 * genuinely emits `ui:show-list` in `activate()` (Task 12): SOMETHING claims
 * it, or `Command.required` rejects with `no-handlers` — which is correct
 * (that is the exact wiring bug the token exists to surface), but is not what
 * most B3/B4 suites are testing. They boot a controller to exercise the
 * reconcile loop, dispose ordering, or the bus itself — not "what happens
 * with no view layer" (that IS covered, deliberately, by
 * `list-controller.test.ts`'s dedicated "no uiShowList handler" case, which
 * must NOT use either helper below). So every other suite gets a trivial,
 * claiming, never-settling renderer instead — the same shape a real
 * `ListView` has from the bus's point of view (claimed, long-lived, closed
 * only by the controller's own `dispose()`), just without a DOM.
 *
 * Two shapes, because two kinds of suite boot a list controller:
 *
 * - `claimListView(bus)` — for a suite that hands `registerViews` a bare
 *   `Commands` and never builds a `ViewAdapter` at all (most of B3, and B4's
 *   ordering suite). Claims directly on the bus via `Commands.listen`,
 *   returning the raw unsubscribe so it can join the suite's own teardown.
 * - `mountListView(adapter)` — for a suite that already owns a real
 *   `ViewAdapter` (B4's dispose-liveness and end-to-end suites). Uses the
 *   adapter's own `on()`, the production entry point.
 *
 * They are not interchangeable. `claimListView` exists separately for a
 * suite (`end-to-end.test.ts`) that asserts on that same adapter's
 * `openViews()`: mounting the list view ON that adapter would make it
 * permanently non-empty — this view never settles until `dispose()` — which
 * would break an assertion the suite makes about a completely different
 * view. Claiming on the raw bus instead keeps the panel off that adapter's
 * books entirely, while still satisfying `Command.required`.
 *
 * B0 boundary note: this module imports `@todo/app/models` (never
 * `@todo/core`) and `@todo/ui`'s public type, so a suite that imports it
 * alongside `@todo/ui` stays within "a todo-ui suite must not import
 * `@todo/core` directly" — the same precedent `end-to-end.test.ts` and
 * `dispose-liveness.test.ts` already set with their own local `seededApi()`.
 */
export function claimListView(bus: Commands): () => void {
  return bus.listen(uiShowList, () => true);
}

/** See `claimListView`'s doc — the `ViewAdapter`-based counterpart. */
export function mountListView(adapter: ViewAdapter): void {
  adapter.on(uiShowList, () => () => {});
}
