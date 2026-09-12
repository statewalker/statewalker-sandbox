/**
 * The viewer page, one containment mode per load.
 *
 * Everything but the containment is rung 06's: the same `pinnedPeer`, the same
 * host app, the same `SwHttpAdapter` edge. The mode arrives as a query
 * parameter so the three runs differ in exactly one thing, which is what makes
 * the comparison evidence rather than three separate demos.
 */

import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { pinnedPeer } from "../../06-ghost-pin/src/ghost.js";
import { createHostApp, type HostLog } from "../../06-ghost-pin/src/host-app.js";
import { type Containment, contain, frameSandbox } from "./contain.js";

declare global {
  interface Window {
    __contain?: {
      mode: Containment;
      ready: boolean;
      baseUrl: string;
      messages: Record<string, string>;
      hostSaw: string[];
      /** Status of the SAME url fetched from the controlled parent document. */
      parentFetch?: number | string;
      error?: string;
    };
  }
}

const PINNED_PEER = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const KEY = "ghost";

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mode = (params.get("mode") ?? "none") as Containment;

  const log: HostLog = { seen: [], lastAuth: null };
  const host = createHostApp(log, false);

  const state: NonNullable<Window["__contain"]> = {
    mode,
    ready: false,
    baseUrl: "",
    messages: {},
    hostSaw: log.seen,
  };
  window.__contain = state;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { k?: string; v?: string };
    if (typeof data?.k === "string" && typeof data.v === "string") {
      state.messages[data.k] = data.v;
    }
  });

  const pinned = pinnedPeer({
    landing: { peerId: PINNED_PEER, appPath: "/app" },
    basePath: `/${KEY}/`,
    token: () => "VIEWER-TOKEN",
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

  // The base URL is only known after registration, and the CSP needs it — so
  // the containment wrapper reads it through a thunk rather than a value.
  let baseUrl = "";
  const registration = await adapter.register(`${KEY}/`, (request) =>
    contain(pinned, { baseUrl, mode })(request),
  );
  baseUrl = registration.baseUrl;
  state.baseUrl = baseUrl;

  // TWO-POINT MEASUREMENT. The parent document is same-origin and therefore
  // ServiceWorker-CONTROLLED, so this proves the ghost is actually serving.
  // If the frame below then fails to load the same URL, the difference is the
  // frame's origin and nothing else — which is the whole question for the
  // sandbox candidate.
  try {
    const probe = await fetch(baseUrl);
    state.parentFetch = probe.status;
  } catch (error) {
    state.parentFetch = `ERR ${String(error)}`;
  }

  const frame = document.createElement("iframe");
  frame.id = "ghost-frame";
  const sandbox = frameSandbox(mode);
  if (sandbox != null) frame.setAttribute("sandbox", sandbox);
  frame.src = baseUrl;
  document.body.appendChild(frame);

  state.ready = true;
}

void main().catch((error: unknown) => {
  window.__contain = {
    mode: "none",
    ready: false,
    baseUrl: "",
    messages: {},
    hostSaw: [],
    error: String(error),
  };
});
