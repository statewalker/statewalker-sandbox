/**
 * HOST dev server — a tiny static file server for the emitted tree.
 *
 * `/`            → index.html (the document; sets <base href="/~/">)
 * `/~/…`         → dist/~/…   (emitted modules: main.js, styles.js, tokens.css, logo.svg)
 * `/~/~deps/…`   → dist/~/~deps/…  (npm dep proxies: react, react-dom)
 *
 * node:fs is fine here — this is the dev-server host boundary (like
 * webrun-modules/examples/http-server.ts), not guest/production code.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 8899);

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Map "/" to index.html; everything else into dist/. normalize() blocks `..`.
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = pathname === "/" ? join(ROOT, "index.html") : join(DIST, rel);

  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`notes-demo on http://localhost:${PORT}  (?mem for a clean in-memory store)`);
});
