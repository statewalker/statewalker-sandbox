// The Kitesurf engine on CellB, in this Dedicated Worker. The page sends requests and CDP sockets.
import { createWebSocketClass, takeClientPort, withUpgrade } from "@statewalker/cellb";
import { loadProject } from "@statewalker/cellb/browser";

// Pages Kitesurf fetches are cross-origin: they go through the server's CORS proxy.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) return nativeFetch(req);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await nativeFetch(`${location.origin}/proxy?url=${encodeURIComponent(req.url)}`, {
    method: req.method,
    headers: req.headers,
    body,
    signal: req.signal,
  });
  const out = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  Object.defineProperty(out, "url", { value: res.headers.get("x-proxy-final-url") ?? req.url });
  return out;
};

const t0 = performance.now();
const project = await loadProject(new URL("/kitesurf/", location.href).href, { data: "kitesurf" });
postMessage({
  type: "ready",
  ms: Math.round(performance.now() - t0),
  unsupported: project.unsupported,
});

self.addEventListener("message", async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "fetch") {
    const res = await project.fetch(new Request(m.url));
    postMessage({ type: "response", id: m.id, status: res.status, text: await res.text() });
  }
  if (m.type === "ws") {
    const port: MessagePort = m.port;
    const req = withUpgrade(new Request(m.url)); // a browser drops `Upgrade` from new Request()
    const res = (await project.fetch(req)) as Response & { webSocket?: unknown };
    if (res.status !== 101 || !res.webSocket) {
      port.postMessage({ error: `upgrade answered ${res.status}: ${await res.text()}` });
      return;
    }
    const wsPort = takeClientPort(res.webSocket as never);
    const WS = createWebSocketClass(async () => ({ port: wsPort }));
    const cell = new WS("ws://cell/") as WebSocket;
    const pending: string[] = [];
    let open = false;
    cell.onopen = () => {
      open = true;
      for (const p of pending.splice(0)) cell.send(p);
      port.postMessage({ open: true });
    };
    cell.onmessage = (ev) => port.postMessage({ data: ev.data });
    cell.onclose = (ev) => port.postMessage({ closed: ev.code });
    port.onmessage = (ev) => (open ? cell.send(ev.data) : pending.push(ev.data));
  }
});
