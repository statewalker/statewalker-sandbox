/**
 * A second, deliberately minimal ServiceWorker that answers ONE question:
 *
 *   When a page aborts a `fetch()`, is the ServiceWorker told?
 *
 * This decides whether the measured hazard (rung 14 claim 4 — an aborted
 * request never reaches the handler) is a TRANSPORT defect that can be fixed,
 * or a platform limit no transport can route around. Rung 13 had to make the
 * same distinction and found a language limit; this is the browser's version
 * of that question, and it must be answered by measurement rather than by
 * reading the deprecation notice.
 *
 * Two possible signals are recorded independently:
 *   - `signal`  — `event.request.signal` fires `abort`.
 *   - `cancel`  — the `ReadableStream` handed to `respondWith` is cancelled.
 *
 * Nothing here uses webrun-http-browser: a defect in the transport must not be
 * able to mask the platform's answer.
 */

/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;

/** What the worker observed, reported back on request. */
const seen = { signal: false, cancel: false, ticks: 0, ended: false };

sw.addEventListener("install", () => {
  void sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
  (event as ExtendableEvent).waitUntil(sw.clients.claim());
});

sw.addEventListener("message", (event) => {
  if ((event.data as { type?: string })?.type !== "probe-report") return;
  (event.source as Client | null)?.postMessage({ type: "probe-report", seen: { ...seen } });
});

sw.addEventListener("fetch", (event) => {
  const request = (event as FetchEvent).request;
  const url = new URL(request.url);
  // The probe lives under its own scope (`/probe-app/`) so its worker cannot
  // collide with the site worker the rest of this rung registers at the root.
  if (!url.pathname.includes("/probe/")) return;

  request.signal.addEventListener("abort", () => {
    seen.signal = true;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let n = 0; n < 40; n++) {
          controller.enqueue(new TextEncoder().encode(`tick-${n}\n`));
          seen.ticks = n + 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        controller.close();
      } catch {
        // `enqueue` after cancellation throws; that is itself a signal, but
        // `cancel` below is the one the spec guarantees.
      } finally {
        seen.ended = true;
      }
    },
    cancel() {
      seen.cancel = true;
    },
  });

  (event as FetchEvent).respondWith(
    new Response(stream, { headers: { "content-type": "text/plain" } }),
  );
});
