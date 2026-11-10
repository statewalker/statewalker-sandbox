// Loaded with --import into the Node engine and every thread it starts. In the SDK's worker
// threads it installs the SDK's blocking host-filesystem bridge (the SDK installs it only in
// its browser workers), and forwards to the parent any request a child worker sends up, so
// every request reaches the engine's main thread (which hands it to node-fs-thread.mjs).
// Those threads also get no fetch: the guest's built-in `wasmer` command would otherwise load
// any registry package (the engine loads the allowed ones itself, in its main thread).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

// The engine's own file thread needs none of this.
if (!isMainThread && !workerData?.bridge) {
  globalThis.fetch = () =>
    Promise.reject(new TypeError("fetch: the Wasmer engine's workers have no network"));
  const dist = dirname(createRequire(import.meta.url).resolve("@wasmer/sdk/node"));
  const { installHostFileSystemWorkerBridge, isHostFileSystemRequest } = await import(
    pathToFileURL(join(dist, "host-filesystem.js")).href
  );
  installHostFileSystemWorkerBridge();
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (event, data, ...rest) {
    if (event === "message" && isHostFileSystemRequest(data)) {
      parentPort.postMessage(data);
      return true;
    }
    return emit.call(this, event, data, ...rest);
  };
}
