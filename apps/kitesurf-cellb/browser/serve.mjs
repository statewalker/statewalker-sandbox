// Static server for the built page and the Kitesurf build, with a CORS proxy at /proxy.
//   node serve.mjs [port]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const port = Number(process.argv[2] ?? 8800);
const roots = [
  new URL("dist/", import.meta.url).pathname,
  new URL("public/", import.meta.url).pathname,
];
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css",
};
const isolation = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

createServer(async (req, res) => {
  // Only this machine's names: a page on another site that rebinds its DNS name to 127.0.0.1
  // must not reach /proxy (which fetches any URL) through the browser.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return void res.end("forbidden host");
  }
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/proxy") {
    try {
      const target = url.searchParams.get("url");
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (
          !["host", "origin", "referer", "connection", "cookie"].includes(k) &&
          typeof v === "string" &&
          !k.startsWith("sec-")
        )
          headers.set(k, v);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const out = { ...isolation, "x-proxy-final-url": upstream.url };
      for (const [k, v] of upstream.headers)
        if (!["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(k))
          out[k] = v;
      res.writeHead(upstream.status, out);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "text/plain", ...isolation });
      res.end(String(e));
    }
    return;
  }
  for (const root of roots) {
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      break; // a malformed %-escape: not found
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) break;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        ...isolation,
      });
      pipeline(createReadStream(file), res).catch(() => res.destroy());
      return;
    }
  }
  res.writeHead(404, isolation);
  res.end("not found");
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
