/**
 * This origin's ServiceWorker script -- built as its own entry
 * (`vite.app.config.ts`) to `dist/app/sw.js`, matching
 * `../../static-server/main.ts`'s default `swFile` and
 * `../../browser/edge.ts`'s `DEFAULT_SERVICE_WORKER_URL`. Byte-for-byte
 * the same one line as `../image-peer/sw.ts`, and deliberately NOT shared
 * between the two: each page's build has its own entry point, and a file
 * whose entire content is one side-effecting import is not worth a shared
 * module that both vite configs would then have to reach across page
 * directories to name.
 *
 * Re-exports `@statewalker/webrun-http-browser`'s ready-made SW runtime
 * (`startHttpDispatcher`, side-effecting on import -- see that package's
 * own `src/sw-worker.ts`) unchanged: `../../browser/edge.ts`'s `mountEdge`
 * is the PAGE-side half of this contract (`SwHttpAdapter`); this file is
 * the WORKER-side half, and there is nothing application-specific for it to
 * do beyond existing at the URL `mountEdge` is told to register.
 */
import "@statewalker/webrun-http-browser/sw-worker";
