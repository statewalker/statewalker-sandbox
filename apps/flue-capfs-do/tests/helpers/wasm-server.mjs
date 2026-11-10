// Serves esbuild.wasm (the esbuild-wasm version the bundler Worker is built for) on a local port,
// with CORS: what a deployment's BUNDLER_WASM_URL points at, for the tests.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

export function startWasmServer(port = 0) {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const bytes = readFileSync(require.resolve("esbuild-wasm/esbuild.wasm"));
  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*" };
    if (req.url !== "/esbuild.wasm") return res.writeHead(404, cors).end();
    res.writeHead(200, { "content-type": "application/wasm", ...cors }).end(bytes);
  });
  return new Promise((ok) =>
    server.listen(port, "127.0.0.1", () =>
      ok({ server, url: `http://127.0.0.1:${server.address().port}/esbuild.wasm` }),
    ),
  );
}
