/**
 * The worker: webrun-http-browser's dispatcher and nothing else — the same
 * one line the stack's own `sw.ts` carries. `HostedSiteBuilder` defaults to
 * `/sw-worker.js`, so this builds to that exact name.
 */
import "@statewalker/webrun-http-browser/sw-worker";
