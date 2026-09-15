import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The three layers, addressed by alias. B0's boundary suite polices them, so
 * these aliases are the seam under test, not a convenience.
 *
 * ONE table, imported by `vite.config.ts` (the app), `vitest.config.ts` (the
 * node suites) and `vitest.browser.config.ts` (the Chromium suites). Its order
 * is load-bearing, and a second copy is a second place to get it wrong. It
 * lives in its own module so the production build config does not have to
 * load `vitest/config` to reach it.
 *
 * `tsconfig.json`'s `paths` repeats these for the type checker, which picks
 * the longest matching prefix and so does not care about order.
 */
/** The implementation a Vitest project resolves `@todo/signals` to. */
export type SignalsImpl = "alien" | "preact";

/** The three layers — order load-bearing, see below. */
const layers = {
  // Before "@todo/app": Vite matches string aliases by PREFIX in declaration
  // order, so the other way round "@todo/app/models" resolves to
  // ".../index.ts/models".
  "@todo/app/models": r("./lib/todo-app/src/models.ts"),
  "@todo/core": r("./lib/todo-core/src/index.ts"),
  "@todo/app": r("./lib/todo-app/src/index.ts"),
  // Before "@todo/ui", for the same prefix reason. The adapter's own entry:
  // the bus-facing half of the view layer, with no React in its import graph,
  // so a headless suite can take it without loading react-dom and the kit.
  "@todo/ui/adapter": r("./lib/todo-ui/src/view-adapter.ts"),
  "@todo/ui": r("./lib/todo-ui/src/index.ts"),
};

/**
 * What the APP is built with: `@todo/signals` is the swap point `deps.ts`,
 * never an implementation directly — so the build uses whatever `deps.ts` says.
 */
export const alias = { "@todo/signals": r("./lib/signals/deps.ts"), ...layers };

/**
 * What a TEST project resolves with: `@todo/signals` pinned to one
 * implementation, so the ladder can run on each. `signals-binding` proves the
 * pin took effect in every project.
 */
export const aliasFor = (signals: SignalsImpl) => ({
  "@todo/signals": r(`./lib/signals/${signals}.ts`),
  ...layers,
});
