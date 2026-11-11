// Serve the Worker project on cellb (Node): wrangler.jsonc's `main` is bundled with esbuild and
// the Durable Objects run on node:sqlite.
//   node scripts/serve-cellb.mjs [--port 8788] [--data .data/cellb] [--var KEY=VALUE]…
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadProject } from "@statewalker/cellb/node";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8788" },
    data: { type: "string" },
    var: { type: "string", multiple: true, default: [] },
  },
});
const projectDir = fileURLToPath(new URL("..", import.meta.url));

// cellb reads vars from the config only: --var loads the project from a temporary copy of the
// config whose `main` points back here.
let dir = projectDir;
let tempDir;
if (values.var.length) {
  const config = JSON.parse(stripJsonc(readFileSync(join(projectDir, "wrangler.jsonc"), "utf8")));
  for (const kv of values.var) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new Error(`--var expects KEY=VALUE, got '${kv}'`);
    config.vars = { ...config.vars, [kv.slice(0, i)]: kv.slice(i + 1) };
  }
  config.main = join(projectDir, config.main);
  delete config.$schema;
  dir = tempDir = mkdtempSync(join(tmpdir(), "tesseract-do-cellb-config-"));
  writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config, null, 2));
}

// JSONC → JSON: drops line and block comments outside strings, and trailing commas.
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

if (values.data) mkdirSync(values.data, { recursive: true });
const project = await loadProject(dir, values.data ? { data: values.data } : {});
if (project.unsupported?.length)
  console.log("cellb: unsupported configuration:", JSON.stringify(project.unsupported));

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const response = await project.fetch(
      new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
});
server.listen(Number(values.port), "127.0.0.1", () =>
  console.log(`cellb: listening on http://127.0.0.1:${values.port}`),
);
const stop = async () => {
  server.close();
  await project.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
