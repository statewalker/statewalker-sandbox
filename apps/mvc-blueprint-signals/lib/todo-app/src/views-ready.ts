/**
 * Proof that the view layer has registered its handlers.
 *
 * `bootstrap()` mints one only after `registerViews` has returned, and
 * `ListController.activate()` refuses to run without a real one (`instanceof`,
 * so `undefined`, `{}` and look-alikes all fail closed). A sibling app
 * documented this exact ordering in a comment on its own `bootstrap()` and
 * enforced it with nothing; anyone constructing a controller directly walked
 * straight past it.
 *
 * What makes it unforgeable is THREE things together, and none of them alone:
 *
 * 1. The constructor is private, so `new ViewsReady()` is a type error.
 * 2. `_mint()` is necessarily public — `bootstrap.ts` is another module — so the
 *    `@todo/app` barrel exports the TYPE only. No caller outside `todo-app`
 *    holds the class value, so none can call `_mint()` or reach its prototype.
 * 3. Inside `todo-app`, and from any suite reaching in by relative path, the
 *    guard is B0: it fails if `_mint` appears anywhere but this file and
 *    `bootstrap.ts`, and if any file but `bootstrap.ts` and
 *    `list-controller.ts` imports this module — because the class value alone
 *    is a forge (`Object.create(ViewsReady.prototype)` passes `instanceof`).
 *
 * A grep polices mistakes, not adversaries: `ViewsReady["_m" + "int"]()` from
 * an allowed file walks past it. The type-only barrel is what stops callers
 * outside this layer, and it does not depend on anyone's spelling.
 *
 * `private` is a compile-time fiction: (1) alone is what the first version of
 * this comment claimed, and a public static next to it made the claim false.
 *
 * Lives in its own module, rather than in `bootstrap.ts`, because
 * `list-controller.ts` needs the type too and `bootstrap.ts` imports
 * `list-controller.ts` — putting it in `bootstrap.ts` would make that a cycle.
 */
export class ViewsReady {
  private constructor() {}

  /** @internal — called only by `bootstrap()`, after `registerViews` has run. B0 enforces "only". */
  static _mint(): ViewsReady {
    return new ViewsReady();
  }
}
