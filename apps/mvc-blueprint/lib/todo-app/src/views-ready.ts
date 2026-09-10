/**
 * Proof that the view layer has registered its handlers.
 *
 * The constructor is private, so no module other than this one can produce an
 * instance — `bootstrap()` mints one (via `_mint()`) only after `registerViews`
 * has returned, and `ListController.activate()` refuses to run without a real
 * one. That is what turns "a controller cannot be activated before the view
 * layer is registered" from a comment into something the type system and the
 * runtime both enforce, for every caller — not just the one that goes through
 * `bootstrap()`. A sibling app documented this exact ordering in a comment on
 * its own `bootstrap()` and enforced it with nothing; anyone constructing a
 * controller directly (as `B3-controller/tests/list-controller.test.ts` used
 * to) walked straight past it.
 *
 * Lives in its own module, rather than in `bootstrap.ts`, because
 * `list-controller.ts` needs the type too and `bootstrap.ts` imports
 * `list-controller.ts` — putting it in `bootstrap.ts` would make that a cycle.
 */
export class ViewsReady {
  private constructor() {}

  /** @internal — called only by `bootstrap()`, after `registerViews` has run. */
  static _mint(): ViewsReady {
    return new ViewsReady();
  }
}
