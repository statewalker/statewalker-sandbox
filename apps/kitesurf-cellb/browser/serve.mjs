// Static server for the built page and the Kitesurf build, with a CORS proxy at /proxy.
//   node serve.mjs [port]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";

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
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain", ...isolation });
      res.end(String(e));
    }
    return;
  }
  for (const root of roots) {
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) break;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        ...isolation,
      });
      createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404, isolation);
  res.end("not found");
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
