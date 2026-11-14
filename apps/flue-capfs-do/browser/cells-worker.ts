// The Dedicated Worker that owns the cells in a browser: it loads the `cellb build` output of
// this project (served at /cellb/) and runs it with SQLite on OPFS. The page talks to it over a
// MessagePort (serveRuntime ↔ connectRuntime); requests travel as HTTP over that port.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveRuntime } from "@statewalker/cellb";
import { loadProject } from "@statewalker/cellb/browser";

const params = new URL(self.location.href).searchParams;
const sqlite3 = await sqlite3InitModule({ locateFile: (f: string) => `/sqlite/${f}` } as never);
const project = await loadProject(new URL("/cellb/", self.location.origin), {
  data: params.get("data") ?? "flue-capfs",
  sqlite3,
  // Worker Loader code runs in a Dedicated Worker of its own (cellb's isolate worker).
  isolateScript: new URL("/isolate-worker.js", self.location.origin),
});
if (project.unsupported.length)
  console.warn("cellb: unsupported configuration", project.unsupported);

self.onmessage = async (e: MessageEvent) => {
  if (e.data?.type !== "connect") return;
  await serveRuntime(e.data.port, project.runtime);
  e.data.port.postMessage({ type: "ready" });
};
self.postMessage({ type: "loaded" });
