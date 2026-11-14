// Serves the browser build (scripts/build-browser.mjs) on a static HTTP server:
//   /                     dist/browser (page, cells worker, isolate worker)
//   /cellb/               dist/cellb (the project, fetched by loadProject)
//   /sqlite/              sqlite3.wasm
//   /pyodide/             node_modules/pyodide (the Python runtime)
//   /python/engine.mjs    the Python engine (a Worker), served with a restrictive CSP
//   /wasmer/engine.mjs    the Wasmer engine (a Worker started by the cells worker)
//   /wasmer/sdk/          node_modules/@wasmer/sdk (served as it is: ES modules and its wasm)
// Every response is cross-origin isolated (COOP/COEP): the Wasmer engine shares memory with the
// cells worker (SharedArrayBuffer).
//   node scripts/serve-browser.mjs [--port 8790] [--no-build]
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildBrowser } from "./build-browser.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const pyodideDir = dirname(require.resolve("pyodide/package.json"));
const wasmerSdkDir = realpathSync(dirname(dirname(require.resolve("@wasmer/sdk/node"))));
const sqliteDir = join(dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json")), "dist");

// The engine Worker may load only same-origin scripts and Pyodide's files; it cannot connect
// anywhere else (fetch, WebSocket, import of other origins).
export const ENGINE_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'";

const MOUNTS = [
  ["/cellb/", join(dir, "dist/cellb")],
  ["/sqlite/", sqliteDir],
  ["/pyodide/", pyodideDir],
  ["/python/", join(dir, "src/python")],
  ["/wasmer/sdk/", wasmerSdkDir],
  ["/wasmer/", join(dir, "src/wasmer")],
  ["/", join(dir, "dist/browser")],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".map": "application/json",
};

export function startServer(port) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const mount = MOUNTS.find(([prefix]) => path.startsWith(prefix));
    let file = mount ? normalize(join(mount[1], path.slice(mount[0].length) || "index.html")) : "";
    if (!mount || !file.startsWith(mount[1])) file = "";
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    const headers = {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    };
    if (path.startsWith("/python/")) headers["content-security-policy"] = ENGINE_CSP;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "8790" }, "no-build": { type: "boolean" } },
  });
  if (!values["no-build"]) await buildBrowser();
  await startServer(Number(values.port));
  console.log(`browser: http://127.0.0.1:${values.port}/`);
}
