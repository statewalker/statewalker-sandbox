/**
 * 14 — the browser rung: the SAME site, published by `HostedSiteBuilder`.
 *
 * Rung 11 ran one site over direct calls, a MessagePort and libp2p. This is
 * the fourth column the directive asks for — *"in the browser the handler
 * could be registered using HostedSiteBuilder … a simplified version to
 * implement the HTTP service in the browser using ServiceWorkers"* — and the
 * one with a known defect underneath it: `SwHttpAdapter` rides
 * `webrun-http-browser`'s `handleHttpRequests`/`sendHttpRequest`, which are
 * `@deprecated` in their own source for having no backpressure, no chunking
 * and no per-stream timeout.
 *
 * The page publishes the site, then runs rung 11's scenario list against its
 * own `fetch()` — so the browser column is produced by exactly the same
 * assertions as the other three.
 */

import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { runScenarios } from "../../11-transports/src/scenarios.js";
import { createSite } from "../../11-transports/src/site.js";

declare global {
  interface Window {
    __rung14?: {
      baseUrl?: string;
      outcomes?: { name: string; pass: boolean; detail: string }[];
      error?: string;
      abort?: {
        rejected: boolean;
        unwound: boolean;
        ticksAtAbort: number;
        ticksAfter: number;
        handlerStillRunning: boolean;
      };
    };
  }
}

const params = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const issuer = params.get("issuer") ?? "";
  const selfPeer = params.get("self") ?? "";
  const subject = params.get("sub") ?? "";
  const goodToken = params.get("good") ?? "";
  const foreignToken = params.get("foreign") ?? "";

  /**
   * A handler that streams slowly and records whether it was ever stopped.
   * Mounted beside the site so the abort claim has something to measure.
   */
  let slowTicks = 0;
  let slowUnwound = false;
  const slow = async (): Promise<Response> => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (let n = 0; n < 40; n++) {
            controller.enqueue(new TextEncoder().encode(`tick-${n}\n`));
            slowTicks = n + 1;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          controller.close();
        } finally {
          slowUnwound = true;
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/plain" } });
  };

  const site = createSite({ issuer, selfPeer, callerOf: () => subject });
  const handler = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname.endsWith("/slow")) return await slow();
    return await site(request);
  };

  const hosted = await new HostedSiteBuilder()
    .setSiteKey("mesh")
    .setServiceWorkerUrl("/sw-worker.js")
    .setHandler(handler)
    .build();

  window.__rung14 = { baseUrl: hosted.baseUrl };

  /**
   * Rung 11's scenarios speak in absolute `http://peer.local/...` URLs. Here
   * the site lives under the page's own origin, so the caller rewrites the
   * path onto `baseUrl` and lets the browser do the rest. That rewrite IS the
   * adapter; everything below it is the same site and the same assertions.
   */
  const call = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const target = `${hosted.baseUrl}${url.pathname.replace(/^\//, "")}${url.search}`;
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.body != null ? { duplex: "half" } : {}),
    } as RequestInit);
  };

  const outcomes = await runScenarios(call, { goodToken, foreignToken });

  // ABORT PROPAGATION, measured rather than read off the source. This was a
  // HAZARD when the rung was first built: the abort stopped at the caller and
  // the handler streamed on for the life of the page. The measurement is
  // unchanged; what changed is webrun-wire underneath it — `toReadableStream`
  // gained a `cancel`, `fromReadableStream` now releases its reader, and the
  // SW transport gained a cancellation message, because closing a
  // `MessagePort` never notifies its peer.
  const controller = new AbortController();
  const pending = fetch(`${hosted.baseUrl}slow`, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  let rejected = false;
  try {
    const response = await pending;
    await response.text();
  } catch {
    rejected = true;
  }
  const ticksAtAbort = slowTicks;
  await new Promise((resolve) => setTimeout(resolve, 800));

  window.__rung14 = {
    baseUrl: hosted.baseUrl,
    outcomes,
    abort: {
      rejected,
      unwound: slowUnwound,
      ticksAtAbort,
      ticksAfter: slowTicks,
      // Kept as the falsifier of the fix: if the producer ever advances again
      // after the caller has gone, the cancellation did not arrive.
      handlerStillRunning: !slowUnwound && slowTicks > ticksAtAbort,
    },
  };
}

void main().catch((error: unknown) => {
  window.__rung14 = { error: String(error) };
});
