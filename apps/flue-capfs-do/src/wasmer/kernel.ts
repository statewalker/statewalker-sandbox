// The Agent-side half of Wasmer execution. It owns one engine (src/wasmer/engine.mjs): a Node
// child process on cellb, a module Worker in a browser, none on workerd and celld. Each run is a
// Wasmer sandbox whose /workspace is the run's capability: the engine forwards every file
// operation the guest makes to this kernel, which answers it with the capability (host-fs.ts).
// Nothing is copied in or out; when the run ends its mount is dropped and late calls are refused.
//
// Programs come from the Wasmer registry (bash, coreutils, ripgrep, …), limited to the
// deployment's WASMER_PACKAGES. Sandboxes have no network.

import type { Cap } from "../caps.ts";
import { pythonRuntime } from "../python/hosts.ts";
import { capHostFs, decodeWire, encodeWire, type HostFsReply, respondInPlace } from "./host-fs.ts";

export interface WasmerEnv {
  /** "off" disables Wasmer tasks. */
  WASMER?: string;
  /** Node: absolute path of src/wasmer/engine.mjs. Browser: its URL (default /wasmer/engine.mjs). */
  WASMER_ENGINE?: string;
  /** Browser: URL of the SDK's dist/index.js (default /wasmer/sdk/dist/index.js). */
  WASMER_SDK?: string;
  /** Node: the package cache directory (absent: no cache, packages are fetched per engine). */
  WASMER_CACHE?: string;
  /** Packages a run may use: JSON array or comma-separated (default below). */
  WASMER_PACKAGES?: string;
}

export interface WasmerRunRequest {
  /** A bash script; /workspace is the capability, the working directory is `cwd`. */
  script: string;
  /** Registry packages (from WASMER_PACKAGES; bash is always there). */
  packages?: string[];
  /** Working directory, a guest path (default /workspace). */
  cwd?: string;
  env?: Record<string, string>;
  /** Per command (default 60 s, at most 300 s). */
  timeoutMs?: number;
}

export interface WasmerResult {
  exitCode: number;
  reason: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export const DEFAULT_PACKAGES = [
  "wasmer/bash",
  "wasmer/coreutils",
  "wasmer/grep",
  "wasmer/ripgrep",
  "wasmer/findutils",
];
const OUTPUT_BYTES = 1024 * 1024;
const OPEN_TIMEOUT_MS = 120_000;
/** A file operation the capability has not answered by then fails (the guest is blocked on it). */
const FS_DEADLINE_MS = 20_000;
/** The engine stops when no sandbox has been open for this long. */
const IDLE_STOP_MS = 5 * 60_000;

type Engine = { post(m: unknown): void; kill(): void };
type EngineMessage =
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "opened"; run: number }
  | ({ type: "result"; run: number; req: number } & WasmerResult)
  | { type: "error"; run: number; req?: number; error: string }
  | {
      type: "wasmer-filesystem-rpc";
      mount: number;
      method: string;
      args: unknown[];
      response: SharedArrayBuffer;
      binary?: boolean;
    };

export interface EngineHost {
  start(
    onMessage: (m: EngineMessage) => void,
    onFsLine: (line: string) => Promise<string>,
    onExit: (why: string) => void,
  ): Promise<Engine>;
  init: Record<string, unknown>;
}

export function allowedPackages(env: WasmerEnv): string[] {
  const raw = env.WASMER_PACKAGES?.trim();
  if (!raw) return DEFAULT_PACKAGES;
  const list = raw.startsWith("[") ? (JSON.parse(raw) as string[]) : raw.split(",");
  return list.map((p) => String(p).trim()).filter(Boolean);
}

/** A sandbox of one run, open until close(). */
export interface WasmerSession {
  exec(
    script: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<WasmerResult>;
  close(): Promise<void>;
}

export class WasmerKernel {
  #host: EngineHost;
  #allowed: string[];
  #engine?: Promise<Engine>;
  #mounts = new Map<number, ReturnType<typeof capHostFs>>();
  #waiting = new Map<string, { resolve: (m: EngineMessage) => void; reject: (e: Error) => void }>();
  #next = 0;
  #opening: Promise<unknown> = Promise.resolve();
  /** Bumped when the engine stops: sessions of an earlier engine fail at once. */
  #generation = 0;
  #open = 0;
  #idle?: ReturnType<typeof setTimeout>;
  #fsQueue: Promise<unknown> = Promise.resolve();

  constructor(host: EngineHost, allowed: string[]) {
    this.#host = host;
    this.#allowed = [...new Set(["wasmer/bash", ...allowed])];
  }

  #start(): Promise<Engine> {
    if (this.#engine) return this.#engine;
    const mine: Promise<Engine> = (async () => {
      let ready!: () => void;
      let failed!: (e: Error) => void;
      const started = new Promise<void>((ok, ko) => {
        ready = ok;
        failed = ko;
      });
      const engine = await this.#host.start(
        (m) => {
          if (m.type === "ready") ready();
          else if (m.type === "failed") failed(new Error(`ENOSYS: wasmer engine: ${m.error}`));
          else this.#onMessage(m);
        },
        (line) => this.#onFsLine(line),
        (why) => {
          failed(new Error(`ENOSYS: wasmer engine exited: ${why}`));
          // Only the current engine's end matters (a stopped one exits later).
          if (this.#engine === mine) this.#crash(why);
        },
      );
      engine.post({ type: "init", packages: this.#allowed, ...this.#host.init });
      try {
        await started;
      } catch (e) {
        engine.kill();
        throw e;
      }
      return engine;
    })();
    this.#engine = mine;
    mine.catch(() => {
      if (this.#engine === mine) this.#engine = undefined;
    });
    return mine;
  }

  #crash(why: string) {
    this.#generation++;
    this.#engine = undefined;
    for (const w of this.#waiting.values())
      w.reject(new Error(`EIO: wasmer engine stopped: ${why}`));
    this.#waiting.clear();
    this.#mounts.clear();
  }

  #onMessage(m: EngineMessage) {
    if (m.type === "wasmer-filesystem-rpc") {
      // Browser: the engine shares memory with this cell; answer in place, one request at a
      // time as on Node (host-fs.ts keeps its open files assuming that).
      const answer = this.#fsQueue.then(() => this.#fs(m.mount, m.method, m.args));
      this.#fsQueue = answer.catch(() => {});
      void answer.then((r) => respondInPlace(m, r));
      return;
    }
    if (m.type === "opened" || m.type === "result" || m.type === "error") {
      const key =
        m.type === "opened" || m.req === undefined ? `open:${m.run}` : `exec:${m.run}:${m.req}`;
      const w = this.#waiting.get(key);
      if (!w) return;
      this.#waiting.delete(key);
      if (m.type === "error")
        w.reject(new Error(m.error.startsWith("E") ? m.error : `EIO: ${m.error}`));
      else w.resolve(m);
    }
  }

  /** Node: one request line from the engine's file thread; the reply line. */
  async #onFsLine(line: string): Promise<string> {
    let r: HostFsReply;
    try {
      const req = JSON.parse(line) as { mount: number; method: string; args: unknown[] };
      r = await this.#fs(req.mount, req.method, decodeWire(req.args) as unknown[]);
    } catch (e) {
      r = { error: { code: "EIO", message: String((e as Error)?.message ?? e) } };
    }
    return JSON.stringify("value" in r ? { value: encodeWire(r.value) } : r);
  }

  #fs(mount: number, method: string, args: unknown[]): Promise<HostFsReply> {
    const h = this.#mounts.get(mount);
    if (!h)
      return Promise.resolve({ error: { code: "EACCES", message: "EACCES: the run is over" } });
    // Node answers one request at a time for every sandbox: none may hold the others forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<HostFsReply>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            error: { code: "ETIMEDOUT", message: `${method}: no answer in ${FS_DEADLINE_MS} ms` },
          }),
        FS_DEADLINE_MS,
      );
    });
    return Promise.race([h.handle(method, args), late]).finally(() => clearTimeout(timer));
  }

  #busy() {
    this.#open++;
    clearTimeout(this.#idle);
    this.#idle = undefined;
  }
  #free() {
    if (--this.#open > 0) return;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (this.#open === 0) this.stop();
    }, IDLE_STOP_MS);
    (this.#idle as { unref?: () => void }).unref?.();
  }

  #wait(key: string, timeoutMs: number): Promise<EngineMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(key);
        reject(new Error(`ETIMEDOUT: wasmer: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiting.set(key, {
        resolve: (m) => (clearTimeout(timer), resolve(m)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  /** A sandbox with `packages`, its /workspace served by `cap`. */
  async open(cap: Cap, packages?: string[]): Promise<WasmerSession> {
    const wanted = [...new Set(["wasmer/bash", ...(packages ?? this.#allowed)])];
    const refused = wanted.filter((p) => !this.#allowed.includes(p));
    if (refused.length)
      throw new Error(`EPERM: wasmer: packages not allowed here: ${refused.join(", ")}`);
    this.#busy();
    let engine: Engine;
    let generation: number;
    const run = ++this.#next;
    try {
      engine = await this.#start();
      generation = this.#generation;
      // One open at a time (the engine also builds one sandbox at a time, for its mount).
      const opened = this.#opening.then(async () => {
        if (generation !== this.#generation)
          throw new Error("EIO: wasmer: the engine stopped while the sandbox was opening");
        this.#mounts.set(run, capHostFs(cap));
        const answer = this.#wait(`open:${run}`, OPEN_TIMEOUT_MS);
        engine.post({ type: "open", run, packages: wanted });
        await answer;
      });
      this.#opening = opened.catch(() => {});
      await opened;
    } catch (e) {
      this.#mounts.delete(run);
      // A late open is closed by the engine when it finishes.
      this.#engine?.then(
        (en) => en.post({ type: "close", run }),
        () => {},
      );
      this.#free();
      throw e;
    }
    let req = 0;
    let closed = false;
    return {
      exec: async (script, opts = {}) => {
        if (typeof script !== "string" || !script)
          throw new Error("EINVAL: wasmer: script is required");
        if (closed) throw new Error("EBADF: wasmer: the session is closed");
        if (generation !== this.#generation)
          throw new Error("EIO: wasmer: the engine stopped; open a new session");
        const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 60_000, 1000), 300_000);
        const n = ++req;
        const answer = this.#wait(`exec:${run}:${n}`, timeoutMs + 10_000).catch((e: Error) => {
          // The engine did not stop the command in time: it is stuck, start over.
          if (e.message.startsWith("ETIMEDOUT") && generation === this.#generation) {
            this.stop();
          }
          throw e;
        });
        engine.post({
          type: "exec",
          run,
          req: n,
          script,
          cwd: opts.cwd,
          env: opts.env,
          timeoutMs,
          outputBytes: OUTPUT_BYTES,
        });
        const {
          type: _t,
          run: _r,
          req: _q,
          ...result
        } = (await answer) as EngineMessage & {
          type: "result";
        };
        return result as WasmerResult;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.#mounts.get(run)?.close();
        this.#mounts.delete(run);
        if (generation === this.#generation) engine.post({ type: "close", run });
        this.#free();
      },
    };
  }

  /** One script in a fresh sandbox. */
  async run(cap: Cap, req: WasmerRunRequest): Promise<WasmerResult> {
    const session = await this.open(cap, req.packages);
    try {
      return await session.exec(req.script, req);
    } finally {
      await session.close();
    }
  }

  stop() {
    clearTimeout(this.#idle);
    this.#idle = undefined;
    const engine = this.#engine;
    if (!engine) return;
    this.#crash("stopped");
    void engine.then(
      (e) => e.kill(),
      () => {},
    );
  }
}

// ---- where the engine runs ----

type ProcessLike = {
  versions?: { node?: string };
  execPath?: string;
  env?: Record<string, string>;
};
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
  crossOriginIsolated?: boolean;
};

export function wasmerHost(env: WasmerEnv): EngineHost {
  if (env.WASMER === "off")
    throw new Error("ENOSYS: wasmer is disabled in this deployment (WASMER=off)");
  const runtime = pythonRuntime();
  if (runtime === "node") {
    if (!env.WASMER_ENGINE) throw new Error("ENOSYS: wasmer needs WASMER_ENGINE (a path) on Node");
    return nodeHost(env.WASMER_ENGINE, env.WASMER_CACHE);
  }
  if (runtime === "browser") {
    if (!g.crossOriginIsolated)
      throw new Error("ENOSYS: wasmer needs a cross-origin isolated page (SharedArrayBuffer)");
    return browserHost(env.WASMER_ENGINE ?? "/wasmer/engine.mjs", env.WASMER_SDK);
  }
  throw new Error("ENOSYS: wasmer is not available on this runtime (workerd, celld)");
}

/** What a Node engine inherits: the proxy settings it needs to fetch packages, nothing else. */
function engineEnv(): Record<string, string> {
  const from = (globalThis as { process?: ProcessLike }).process?.env ?? {};
  const out: Record<string, string> = {};
  for (const k of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (from[k]) out[k] = from[k];
  if (out.HTTPS_PROXY || out.https_proxy || out.HTTP_PROXY || out.http_proxy)
    out.NODE_USE_ENV_PROXY = "1";
  return out;
}

function nodeHost(enginePath: string, cache?: string): EngineHost {
  return {
    init: { cache },
    async start(onMessage, onFsLine, onExit) {
      const childProcess = "node:child_process";
      const { fork } = (await import(
        /* @vite-ignore */ childProcess
      )) as typeof import("node:child_process");
      const proc = (globalThis as { process?: ProcessLike }).process;
      // The preload sits next to the engine, whatever the engine file is called: without it the
      // SDK's worker threads would keep their fetch.
      const preload = enginePath.replace(/[^/\\]*$/, "node-preload.mjs");
      const child = fork(enginePath, [], {
        execPath: proc?.execPath,
        execArgv: [
          // The engine reads its own files and the SDK's, writes only the package cache, and
          // starts worker threads; it cannot start processes.
          "--permission",
          "--allow-fs-read=*",
          ...(cache ? [`--allow-fs-write=${cache}`] : []),
          "--allow-worker",
          "--import",
          preload,
          "--max-old-space-size=2048",
          "--no-warnings",
        ],
        env: engineEnv(),
        // 0 1 2 3 = stdin, stdout, stderr, IPC; 4 = file requests (engine → here), 5 = replies.
        stdio: ["ignore", "ignore", "pipe", "ipc", "pipe", "pipe"],
        serialization: "json",
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      const pipes = child.stdio as unknown as unknown[];
      const requests = pipes[4] as NodeJS.ReadableStream;
      const replies = pipes[5] as NodeJS.WritableStream;
      // A broken pipe ends the engine (its file thread can no longer be answered).
      const broken = (e: Error) => {
        child.kill("SIGKILL");
        onExit(`file channel: ${e.message}`);
      };
      (requests as unknown as { on(ev: "error", f: (e: Error) => void): void }).on("error", broken);
      (replies as unknown as { on(ev: "error", f: (e: Error) => void): void }).on("error", broken);
      requests.setEncoding("utf8");
      let buffered = "";
      // Requests come one at a time (the engine's file thread waits for each reply).
      let chain: Promise<unknown> = Promise.resolve();
      requests.on("data", (d: string | Buffer) => {
        buffered += d;
        let nl = buffered.indexOf("\n");
        while (nl >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          chain = chain.then(async () => replies.write(`${await onFsLine(line)}\n`));
          nl = buffered.indexOf("\n");
        }
      });
      child.on("message", (m) => onMessage(m as EngineMessage));
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

function browserHost(engineUrl: string, sdkUrl?: string): EngineHost {
  return {
    init: { sdk: sdkUrl ? new URL(sdkUrl, g.location?.href).href : undefined },
    async start(onMessage, _onFsLine, onExit) {
      const Worker = g.Worker as NonNullable<typeof g.Worker>;
      const worker = new Worker(new URL(engineUrl, g.location?.href), {
        type: "module",
        name: "wasmer-engine",
      });
      worker.addEventListener("message", (e) => onMessage(e.data as EngineMessage));
      worker.addEventListener("error", (e) => onExit(e.message || "worker error"));
      return { post: (m) => worker.postMessage(m), kill: () => worker.terminate() };
    },
  };
}
