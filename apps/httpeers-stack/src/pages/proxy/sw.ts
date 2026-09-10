/**
 * This origin's ServiceWorker script -- built as its own entry
 * (`vite.proxy.config.ts`) to `dist/proxy/sw.js`, matching
 * `../../static-server/main.ts`'s default `swFile`. Re-exports
 * `@statewalker/webrun-http-browser`'s ready-made SW runtime
 * (`startHttpDispatcher`, side-effecting on import -- see that package's
 * own `src/sw-worker.ts`) unchanged: `../../browser/edge.ts`'s `mountEdge`
 * is the PAGE-side half of this contract (`SwHttpAdapter`); this file is
 * the WORKER-side half, and there is nothing application-specific for it
 * to do beyond existing at the URL `mountEdge` is told to register.
 */
import "@statewalker/webrun-http-browser/sw-worker";
