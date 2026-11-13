// Runs the Kitesurf engine Worker on CellB in Node and serves it over HTTP + WebSocket.
//   node server.mjs <kitesurf/packages/engine> [port]
import "./polyfills.mjs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createWebSocketClass, takeClientPort } from "@statewalker/cellb";
import { loadProject } from "@statewalker/cellb/node";
import { WebSocketServer } from "ws";

const dir = process.argv[2] ?? "../kitesurf/packages/engine";
const port = Number(process.argv[3] ?? process.env.PORT ?? 8787);

const project = await loadProject(dir);
console.log("cellb: loaded", dir, "unsupported:", project.unsupported);

const toRequest = (req, body) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`;
  const init = { method: req.method, headers };
  if (body && req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
};

const server = createServer(async (req, res) => {
  try {
    const r = await project.fetch(toRequest(req, true));
    const headers = {};
    for (const [k, v] of r.headers) {
      if (k === "set-cookie") continue;
      headers[k] = v;
    }
    const cookies = r.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(r.status, headers);
    if (r.body && req.method !== "HEAD") Readable.fromWeb(r.body).pipe(res);
    else res.end();
  } catch (e) {
    console.error("request failed", req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
});

// WebSocket upgrades: hand the handshake to the Worker; a `101` + `webSocket` answer is bridged
// to the real socket (the same pattern as CellB's celld peer tunnel, src/peer/celld-peer.ts).
const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => [...p][0] ?? false });
server.on("upgrade", async (req, socket, head) => {
  const fail = (status, body) =>
    socket.end(
      `HTTP/1.1 ${status} Error\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  let res;
  try {
    res = await project.fetch(toRequest(req, false));
  } catch (e) {
    return fail(500, String(e?.message ?? e));
  }
  if (res.status !== 101 || !res.webSocket) return fail(res.status, await res.text());
  const offered = req.headers["sec-websocket-protocol"];
  const wsPort = takeClientPort(res.webSocket);
  const WS = createWebSocketClass(async () => ({
    port: wsPort,
    protocol: res.headers.get("Sec-WebSocket-Protocol") ?? undefined,
  }));
  const cell = new WS("ws://cell/", offered ? offered.split(",").map((s) => s.trim()) : undefined);
  cell.binaryType = "arraybuffer";
  const pending = [];
  let open = false;
  wss.handleUpgrade(req, socket, head, (client) => {
    cell.onopen = () => {
      open = true;
      for (const m of pending.splice(0)) cell.send(m);
    };
    client.on("message", (data, isBinary) => {
      const m = isBinary ? new Uint8Array(data).buffer : data.toString();
      if (open) cell.send(m);
      else pending.push(m);
    });
    cell.onmessage = (ev) =>
      client.send(ev.data instanceof ArrayBuffer ? Buffer.from(ev.data) : ev.data);
    const code = (c) => (c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 ? c : 1000);
    client.on("close", (c, reason) => cell.close(code(c), reason.toString()));
    cell.onclose = (ev) => client.close(code(ev.code), ev.reason);
  });
});

server.listen(port, "127.0.0.1", () => console.log(`kitesurf on cellb: http://127.0.0.1:${port}`));
const stop = async () => {
  server.close();
  await project.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
