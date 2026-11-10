// The Wasmer engine: runs WASIX packages (bash, coreutils, ripgrep, …) in Wasmer sandboxes whose
// /workspace is the agent's capability. One engine per Agent kernel; one sandbox per run.
//   Node (cellb):  a child process (src/wasmer/hosts.ts). Control messages over IPC; the
//                  sandbox's file operations over two pipes (fd 4: requests, fd 5: replies),
//                  answered by the Agent cell through the capability.
//   Browser:       a module Worker started by the cells worker. File operations are the SDK's
//                  own blocking bridge messages, answered by the Agent cell in place (shared
//                  memory), so the page must be cross-origin isolated.
//
// Messages (Agent → engine):
//   {type:"init", sdk?}                                   sdk: the SDK's module URL (browser)
//   {type:"open", run, packages, env?}                    → {type:"opened", run} | {type:"error", run, error}
//   {type:"exec", run, req, script, cwd?, env?, timeoutMs?, outputBytes?}
//                                                         → {type:"result", run, req, exitCode, reason, stdout, stderr, truncated}
//   {type:"close", run}
// Engine → Agent: {type:"ready"} | {type:"failed", error}; browser only: the SDK's
// {type:"wasmer-filesystem-rpc", mount, method, args, response, binary} requests.
//
// The SDK's `storageHost(mount)` (an embedder filesystem as /workspace) is experimental and not
// in its public options: each sandbox is built through the core builder, with the run id as
// the mount id.

const IN_NODE =
  typeof process !== "undefined" &&
  !!process.versions?.node &&
  typeof window === "undefined" &&
  typeof WorkerGlobalScope === "undefined";
const send = IN_NODE ? (m) => process.send?.(m) : (m) => self.postMessage(m);

let sdk;
let core;
let wasmer;
let nextMount = 0;
const sandboxes = new Map();

async function init(m) {
  if (IN_NODE) {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { Worker } = await import("node:worker_threads");
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve("@wasmer/sdk/node"));
    sdk = await import(pathToFileURL(join(dist, "node.js")).href);
    core = await import(pathToFileURL(join(dist, "../pkg/wasmer_sdk_js.js")).href);
    const bridge = await import(pathToFileURL(join(dist, "host-filesystem.js")).href);
    // File requests are answered by a thread of their own that talks to the Agent over pipes:
    // this thread may itself be the one waiting on a reply.
    const fsThread = new Worker(new URL("./node-fs-thread.mjs", import.meta.url), {
      workerData: { bridge: pathToFileURL(join(dist, "host-filesystem.js")).href },
    });
    fsThread.unref();
    bridge.installHostFileSystemWorkerBridge((req) => (fsThread.postMessage(req), true));
    // Requests from the SDK's worker threads (forwarded by node-preload.mjs) go there too.
    const emit = Worker.prototype.emit;
    Worker.prototype.emit = function (event, data, ...rest) {
      if (this !== fsThread && event === "message" && bridge.isHostFileSystemRequest(data)) {
        fsThread.postMessage(data);
        return true;
      }
      return emit.call(this, event, data, ...rest);
    };
    wasmer = new sdk.Wasmer({ cache: m.cache ? { directory: m.cache } : false });
  } else {
    const base = new URL(m.sdk ?? "/wasmer/sdk/dist/index.js", self.location.href);
    sdk = await import(base.href);
    core = await import(new URL("../pkg/wasmer_sdk_js.js", base).href);
    const bridge = await import(new URL("./host-filesystem.js", base).href);
    // This worker's own calls block here, answered in place by the Agent cell (its parent).
    bridge.installHostFileSystemWorkerBridge();
    // Calls from the SDK's workers arrive here as messages: forward them to the Agent cell.
    const NativeWorker = self.Worker;
    self.Worker = class extends NativeWorker {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (e) => {
          if (bridge.isHostFileSystemRequest(e.data)) {
            e.stopImmediatePropagation();
            self.postMessage(e.data);
          }
        });
      }
    };
    wasmer = new sdk.Wasmer();
  }
  // Every sandbox built from here gets the Agent's filesystem (mount nextMount) as /workspace.
  const start = core.SandboxBuilderCore.prototype.start;
  core.SandboxBuilderCore.prototype.start = function () {
    this.storageHost(nextMount);
    return start.call(this);
  };
  await wasmer.ready();
}

async function open(m) {
  nextMount = m.run;
  const shell = m.packages.includes("wasmer/bash") ? "bash" : undefined;
  const sandbox = await wasmer.sandboxes.create({
    packages: m.packages,
    shell,
    env: m.env ?? {},
    network: { mode: "disabled" },
  });
  sandboxes.set(m.run, sandbox);
}

async function exec(m) {
  const sandbox = sandboxes.get(m.run);
  if (!sandbox) throw Object.assign(new Error("no sandbox for this run"), { code: "EBADF" });
  const out = await sandbox
    .shell(m.script, { cwd: m.cwd ?? "/workspace", env: m.env })
    .run({ check: false, timeoutMs: m.timeoutMs, outputBytes: m.outputBytes });
  return {
    exitCode: out.exitCode,
    reason: out.reason,
    stdout: new TextDecoder().decode(out.stdout.bytes),
    stderr: new TextDecoder().decode(out.stderr.bytes),
    truncated: out.stdout.truncated || out.stderr.truncated,
  };
}

async function handle(m) {
  try {
    if (m.type === "init") {
      await init(m);
      send({ type: "ready" });
    } else if (m.type === "open") {
      await open(m);
      send({ type: "opened", run: m.run });
    } else if (m.type === "exec") {
      send({ type: "result", run: m.run, req: m.req, ...(await exec(m)) });
    } else if (m.type === "close") {
      const s = sandboxes.get(m.run);
      sandboxes.delete(m.run);
      await s?.close();
    }
  } catch (e) {
    const error = `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`;
    if (m.type === "init") send({ type: "failed", error });
    else send({ type: "error", run: m.run, req: m.req, error });
  }
}

if (IN_NODE) process.on("message", (m) => void handle(m));
else self.onmessage = ({ data }) => void handle(data);
