// Serve the Worker project on cellb (Node): wrangler.jsonc's `main` is bundled with esbuild
// and the Durable Objects run on node:sqlite.
//   node scripts/serve-cellb.mjs [--port 8788] [--data .data/cellb]
//   node scripts/serve-cellb.mjs --celld-bucket .celld/dev/objects.sqlite3
//   node scripts/serve-cellb.mjs --var 'TOOL_BUNDLE={"hostFsRuntimes":"bundled-only"}'
// --celld-bucket keeps every cell in celld's own format (LTX logs, ownership records) in the
// SQLite object store `celld dev` uses, so `celld dev` can take the same cells over.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { celldBucket } from "@statewalker/cellb";
import {
  loadNodeProject,
  loadProject,
  nodeSqliteOpener,
  sqliteObjectStore,
} from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8788" },
    data: { type: "string" },
    "celld-bucket": { type: "string" },
    var: { type: "string", multiple: true, default: [] },
  },
});
const projectDir = fileURLToPath(new URL("..", import.meta.url));
// --var KEY=VALUE overrides wrangler.jsonc `vars` (cellb reads vars from the config only): the
// project is loaded from a temporary copy of the config whose `main` points back here.
let dir = projectDir;
if (values.var.length) {
  const config = JSON.parse(
    readFileSync(join(projectDir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  for (const kv of values.var) {
    const i = kv.indexOf("=");
    config.vars = { ...config.vars, [kv.slice(0, i)]: kv.slice(i + 1) };
  }
  config.main = join(projectDir, config.main);
  delete config.$schema;
  dir = mkdtempSync(join(tmpdir(), "flue-capfs-cellb-config-"));
  writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config, null, 2));
}

let project;
if (values["celld-bucket"]) {
  const file = values["celld-bucket"];
  mkdirSync(dirname(file), { recursive: true });
  const { runtime, unsupported } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(), // in memory: every cell is restored from the bucket on first use
    files: new MemFilesApi(),
    storage: celldBucket(sqliteObjectStore(file), { node: "cellb-1" }),
  });
  project = { fetch: (r) => runtime.fetch(r), close: () => runtime.close(), unsupported };
} else {
  if (values.data) mkdirSync(values.data, { recursive: true });
  project = await loadProject(dir, values.data ? { data: values.data } : {});
}
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
  await project.close(); // releases the cells, so celld can take them at once
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
