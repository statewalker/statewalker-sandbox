/**
 * This origin's ServiceWorker script -- built as its own entry
 * (`vite.hub.config.ts`) to `dist/hub/sw.js`, matching
 * `../../static-server/main.ts`'s default `swFile`. Re-exports
 * `@statewalker/webrun-http-browser`'s ready-made SW runtime
 * (`startHttpDispatcher`, side-effecting on import -- see that package's
 * own `src/sw-worker.ts`) unchanged: `../../browser/edge.ts`'s `mountEdge`
 * is the PAGE-side half of this contract (`SwHttpAdapter`); this file is
 * the WORKER-side half, and there is nothing application-specific for it
 * to do beyond existing at the URL `mountEdge` is told to register.
 *
 * Identical to `../image-peer/sw.ts` and `../app/sw.ts`, and deliberately a
 * separate file rather than one shared module the three configs point at:
 * each origin's ServiceWorker is its own build entry, and a page's `sw.ts`
 * sitting beside its `main.ts` is what makes "this origin registers this
 * worker" readable from the directory alone.
 */
import "@statewalker/webrun-http-browser/sw-worker";
