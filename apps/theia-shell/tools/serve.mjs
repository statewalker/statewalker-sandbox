// A plain static file server: the whole point of a browser-only Theia app is that
// this is all it needs. Usage: node serve.mjs <dir> <port>
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const [root = ".", port = "3000"] = process.argv.slice(2);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/__health") {
    res.writeHead(200).end("ok");
    return;
  }
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(normalize(root))) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    statSync(path);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
}).listen(Number(port), "127.0.0.1", () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
