// Where the Python engine runs, per runtime:
//   Node (cellb):     a child process. Node's permission model lets it read only Pyodide's
//                     directory and the engine script; it cannot write files, start processes or
//                     workers; code generation from strings is disabled (no Function("…") escape
//                     through Pyodide's FFI). Its environment is empty.
//   Browser (cellb):  a module Worker (/python/engine.mjs), served with a restrictive CSP.
//   workerd:          not available (no child processes; WebAssembly compilation of fetched
//                     bytes is not allowed there).

import type { EngineHost } from "./kernel.ts";

export interface PythonEnv {
  /** Node: absolute path of src/python/engine.mjs. Browser: its URL (default /python/engine.mjs). */
  PYTHON_ENGINE?: string;
  /** Node: absolute path of Pyodide's directory (…/node_modules/pyodide/). Browser: its URL (default /pyodide/). */
  PYODIDE_INDEX?: string;
  /** "off" disables Python tasks. */
  PYTHON?: string;
}

type ProcessLike = { versions?: { node?: string }; execPath?: string };
// Browser globals (not in the Workers type definitions).
type WorkerLike = {
  postMessage(m: unknown): void;
  terminate(): void;
  addEventListener(
    type: "message" | "error",
    fn: (e: { data?: unknown; message?: string }) => void,
  ): void;
};
const g = globalThis as unknown as {
  Worker?: new (url: URL, opts: { type: "module"; name?: string }) => WorkerLike;
  location?: { href: string };
};
const proc = (globalThis as { process?: ProcessLike }).process;
// workers-types 5 declares `navigator` as a global const (not a globalThis property), shadowing
// @types/node's var: read it through a narrow type.
const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
const IN_WORKERD = /Cloudflare-Workers/.test(userAgent ?? "");
// cellb's nodejs_compat polyfills `process` in browsers (with versions.node): a browser is
// recognized by its global scope, not by `process`.
const IN_BROWSER =
  !IN_WORKERD &&
  typeof g.Worker === "function" &&
  typeof g.location === "object" &&
  ("WorkerGlobalScope" in globalThis || "window" in globalThis);
const IN_NODE = !IN_WORKERD && !IN_BROWSER && !!proc?.versions?.node;

export function pythonRuntime(): "node" | "browser" | "none" {
  return IN_NODE ? "node" : IN_BROWSER ? "browser" : "none";
}

export function engineHost(env: PythonEnv): EngineHost {
  if (env.PYTHON === "off")
    throw new Error("ENOSYS: python is disabled in this deployment (PYTHON=off)");
  if (IN_NODE) {
    if (!env.PYTHON_ENGINE || !env.PYODIDE_INDEX) {
      throw new Error("ENOSYS: python needs PYTHON_ENGINE and PYODIDE_INDEX (paths) on Node");
    }
    return nodeHost(env.PYTHON_ENGINE, env.PYODIDE_INDEX.replace(/\/?$/, "/"));
  }
  if (IN_BROWSER)
    return browserHost(env.PYTHON_ENGINE ?? "/python/engine.mjs", env.PYODIDE_INDEX ?? "/pyodide/");
  throw new Error("ENOSYS: python is not available on this runtime (workerd)");
}

function nodeHost(enginePath: string, indexDir: string): EngineHost {
  return {
    indexURL: indexDir,
    async start(onMessage, onExit) {
      // A non-literal specifier: bundlers for other runtimes leave this import alone.
      const childProcess = "node:child_process";
      const { fork } = (await import(
        /* @vite-ignore */ childProcess
      )) as typeof import("node:child_process");
      const child = fork(enginePath, [], {
        execPath: proc?.execPath,
        execArgv: [
          "--permission",
          `--allow-fs-read=${indexDir}`,
          `--allow-fs-read=${enginePath}`,
          "--disallow-code-generation-from-strings",
          "--max-old-space-size=1024",
        ],
        env: {},
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.on("message", (m) => onMessage(m as never));
      child.on("exit", (code, signal) =>
        onExit(`exit ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`),
      );
      child.on("error", (e) => onExit(String(e.message)));
      return {
        post: (m) => child.connected && child.send(m as never),
        kill: () => child.kill("SIGKILL"),
      };
    },
  };
}

function browserHost(engineUrl: string, indexURL: string): EngineHost {
  return {
    indexURL,
    async start(onMessage, onExit) {
      const Worker = g.Worker as NonNullable<typeof g.Worker>;
      const worker = new Worker(new URL(engineUrl, g.location?.href), {
        type: "module",
        name: "python-engine",
      });
      worker.addEventListener("message", (e) => onMessage(e.data as never));
      worker.addEventListener("error", (e) => onExit(e.message || "worker error"));
      return {
        post: (m) => worker.postMessage(m),
        kill: () => worker.terminate(),
      };
    },
  };
}
