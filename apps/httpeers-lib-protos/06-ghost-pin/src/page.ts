/**
 * The VIEWER page: mount a ghost on the ServiceWorker edge and render the host
 * peer's app in an iframe.
 *
 * The edge is `@statewalker/webrun-http-browser`'s `SwHttpAdapter`, used the
 * same way `apps/httpeers-stack/src/browser/edge.ts` uses it — the page is the
 * server, the worker dispatches to it. The only difference from the stack's
 * edge is WHAT is registered: `pinnedPeer` instead of `createEdgeDispatch`.
 */

import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { pinnedPeer } from "./ghost.js";
import { createHostApp, type HostLog } from "./host-app.js";

declare global {
  interface Window {
    __ghost?: {
      ready: boolean;
      baseUrl: string;
      messages: Record<string, string>;
      hostSaw: string[];
      lastAuth: string | null;
      error?: string;
    };
  }
}

const PINNED_PEER = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const KEY = "ghost";

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const useBaseHref = params.get("base") === "1";

  const log: HostLog = { seen: [], lastAuth: null };
  const host = createHostApp(log, useBaseHref);

  const state: NonNullable<Window["__ghost"]> = {
    ready: false,
    baseUrl: "",
    messages: {},
    hostSaw: log.seen,
    lastAuth: null,
  };
  window.__ghost = state;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { k?: string; v?: string };
    if (typeof data?.k === "string" && typeof data.v === "string") {
      state.messages[data.k] = data.v;
      state.lastAuth = log.lastAuth;
    }
  });

  const handler = pinnedPeer({
    landing: { peerId: PINNED_PEER, appPath: "/app" },
    basePath: `/${KEY}/`,
    token: () => "VIEWER-TOKEN",
    // The mesh hop, stubbed: whatever the pin decided to send, the pinned peer
    // receives. A request for any OTHER peer never reaches here — the pin
    // cannot express one.
    remote: async (peerId, request) => {
      if (peerId !== PINNED_PEER) {
        return new Response(`ghost tried to reach ${peerId}`, { status: 500 });
      }
      return host(request);
    },
  });

  const adapter = new SwHttpAdapter({
    key: KEY,
    serviceWorkerUrl: new URL("/sw.js", location.href).href,
  });
  await adapter.start();
  const registration = await adapter.register(`${KEY}/`, handler);

  state.baseUrl = registration.baseUrl;

  const frame = document.createElement("iframe");
  frame.id = "ghost-frame";
  frame.src = `${registration.baseUrl}`;
  document.body.appendChild(frame);

  state.ready = true;
}

void main().catch((error: unknown) => {
  window.__ghost = {
    ready: false,
    baseUrl: "",
    messages: {},
    hostSaw: [],
    lastAuth: null,
    error: String(error),
  };
});
