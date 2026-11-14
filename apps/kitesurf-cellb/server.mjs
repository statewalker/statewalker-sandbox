// Runs the Kitesurf engine Worker on CellB in Node and serves it over HTTP + WebSocket.
//   node server.mjs <kitesurf/packages/engine> [port]
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
    // pipeline, not pipe: a body that fails mid-stream ends this response, not the process.
    if (r.body && req.method !== "HEAD") await pipeline(Readable.fromWeb(r.body), res);
    else res.end();
  } catch (e) {
    console.error("request failed", req.method, req.url, e);
    if (res.headersSent) return void res.destroy();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
});

// WebSocket upgrades: hand the handshake to the Worker; a `101` + `webSocket` answer is bridged
// to the real socket (the same pattern as CellB's celld peer tunnel, src/peer/celld-peer.ts).
// The subprotocol the client gets is the one the Worker chose (its 101's Sec-WebSocket-Protocol).
const chosen = new WeakMap();
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (_offered, req) => chosen.get(req) ?? false,
});
server.on("upgrade", async (req, socket, head) => {
  // Node drops its own socket error listener on upgrade: a client reset must not end the process.
  socket.on("error", (e) => console.error("upgrade socket:", e.message));
  const fail = (status, body) =>
    socket.end(
      `HTTP/1.1 ${status} Error\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  let cell;
  try {
    const res = await project.fetch(toRequest(req, false));
    if (res.status !== 101 || !res.webSocket) return fail(res.status, await res.text());
    const offered = req.headers["sec-websocket-protocol"];
    const protocol = res.headers.get("Sec-WebSocket-Protocol") ?? undefined;
    if (protocol) chosen.set(req, protocol);
    const wsPort = takeClientPort(res.webSocket);
    const WS = createWebSocketClass(async () => ({ port: wsPort, protocol }));
    cell = new WS("ws://cell/", offered ? offered.split(",").map((s) => s.trim()) : undefined);
    cell.binaryType = "arraybuffer";
  } catch (e) {
    return fail(500, String(e?.message ?? e));
  }
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
    // The codes each close() takes: the Worker's socket follows the WebSocket API (1000 and
    // 3000-4999); ws also takes 1001-1014 except 1004-1006. Others become 1000.
    const toCell = (c) => (c === 1000 || (c >= 3000 && c < 5000) ? c : 1000);
    const toClient = (c) =>
      (c >= 1000 && c <= 1014 && ![1004, 1005, 1006].includes(c)) || (c >= 3000 && c < 5000)
        ? c
        : 1000;
    client.on("close", (c, reason) => cell.close(toCell(c), reason.toString()));
    cell.onclose = (ev) => client.close(toClient(ev.code), ev.reason);
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
