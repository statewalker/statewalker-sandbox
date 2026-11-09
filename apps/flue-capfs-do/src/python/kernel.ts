// The kernel: the Agent-side half of Python execution. It owns one engine (a permission-
// restricted Node child process, or a browser Worker), copies the files a capability can read
// into the engine's /workspace before a run, answers the engine's live `capfs` calls with the
// capability, and writes the run's changes back THROUGH the capability: whatever the code did
// in its sandbox, only authorized writes reach the store.

import type { Cap } from "../caps.ts";
import { fsError, join, normalise } from "../path.ts";

export interface PythonRunRequest {
  code: string;
  /** Capability path copied into /workspace (default "/": everything the capability can read). */
  root?: string;
  /** Working directory, a capability path (default: root). */
  cwd?: string;
  timeoutMs?: number;
  /** Start a new engine for this run (no state from earlier runs of this agent). */
  fresh?: boolean;
}

export interface PythonRunResult {
  stdout: string;
  stderr: string;
  /** repr of the last expression, if any. */
  value: unknown;
  /** The Python traceback, when the code raised. */
  error?: string;
  synced: { files: number; bytes: number; truncated: boolean };
  written: string[];
  deleted: string[];
  denied: { path: string; op: string; error: string }[];
}

export interface EngineHost {
  /** Starts an engine; `onMessage` receives its messages; `post` sends one. */
  start(
    onMessage: (m: EngineMessage) => void,
    onExit: (why: string) => void,
  ): Promise<{ post(m: unknown): void; kill(): void }>;
  indexURL: string;
}

type EngineMessage =
  | { type: "ready"; version: string }
  | { type: "failed"; error: string }
  | { type: "cap"; id: number; method: string; args: unknown[] }
  | {
      type: "result";
      id: number;
      stdout: string;
      stderr: string;
      value: unknown;
      error?: string;
      changes: {
        written: Record<string, string>;
        binary: string[];
        deleted: string[];
        dirs: string[];
      };
    };

const LIMITS = { files: 5000, bytes: 16 * 1024 * 1024 };
/** An engine with nothing to do is stopped after this long (its memory is released). */
const IDLE_MS = 5 * 60_000;
const CAP_METHODS = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "readdir",
  "exists",
  "stat",
  "mkdir",
  "rm",
]);

export class PythonKernel {
  #host: EngineHost;
  #engine?: Promise<{ post(m: unknown): void; kill(): void }>;
  #version?: string;
  #runs = new Map<
    number,
    {
      resolve: (m: EngineMessage & { type: "result" }) => void;
      reject: (e: Error) => void;
      cap: Cap;
    }
  >();
  #nextRun = 0;
  #busy: Promise<unknown> = Promise.resolve();
  #idle?: ReturnType<typeof setTimeout>;

  constructor(host: EngineHost) {
    this.#host = host;
  }

  get version() {
    return this.#version;
  }

  #start() {
    this.#engine ??= (async () => {
      let ready!: (v: string) => void;
      let failed!: (e: Error) => void;
      const started = new Promise<string>((ok, ko) => {
        ready = ok;
        failed = ko;
      });
      const engine = await this.#host.start(
        (m) => this.#onMessage(m, ready, failed),
        (why) => {
          failed(new Error(`ENOSYS: python engine exited: ${why}`));
          this.#crash(why);
        },
      );
      engine.post({ type: "init", indexURL: this.#host.indexURL });
      this.#version = await started;
      return engine;
    })();
    this.#engine.catch(() => (this.#engine = undefined));
    return this.#engine;
  }

  #crash(why: string) {
    this.#engine = undefined;
    for (const r of this.#runs.values()) r.reject(new Error(`EIO: python engine stopped: ${why}`));
    this.#runs.clear();
  }

  stop() {
    this.#engine?.then(
      (e) => e.kill(),
      () => {},
    );
    this.#crash("stopped");
  }

  #onMessage(m: EngineMessage, ready: (v: string) => void, failed: (e: Error) => void) {
    if (m?.type === "ready") ready(m.version);
    else if (m?.type === "failed")
      failed(new Error(`ENOSYS: python engine failed to start: ${m.error}`));
    else if (m?.type === "result") {
      const r = this.#runs.get(m.id);
      if (!r) return;
      this.#runs.delete(m.id);
      r.resolve(m);
    } else if (m?.type === "cap") void this.#answerCap(m);
  }

  /** A live `capfs` call from Python: only the file methods, always through the capability. */
  async #answerCap(m: EngineMessage & { type: "cap" }) {
    const run = [...this.#runs.values()].at(-1); // runs are serialized: the current one
    const reply = (ok: boolean, value?: unknown, error?: string) =>
      this.#engine?.then((e) => e.post({ type: "capResult", id: m.id, ok, value, error }));
    if (!run || !CAP_METHODS.has(m.method) || !Array.isArray(m.args)) {
      return reply(false, undefined, `ENOSYS: ${String(m.method)} is not available`);
    }
    try {
      const [path, ...rest] = m.args as [string, ...unknown[]];
      const value =
        m.method === "readdir"
          ? await run.cap.readdir(path)
          : await run.cap.call(m.method, path, ...rest);
      await reply(true, value ?? null);
    } catch (e) {
      await reply(false, undefined, String((e as Error)?.message ?? e));
    }
  }

  /** One run at a time per kernel (the engine has one interpreter). */
  run(cap: Cap, req: PythonRunRequest): Promise<PythonRunResult> {
    if (this.#idle) clearTimeout(this.#idle);
    const next = this.#busy.then(() => this.#run(cap, req));
    this.#busy = next.catch(() => {});
    this.#busy.then(() => {
      this.#idle = setTimeout(() => this.stop(), IDLE_MS);
    });
    return next;
  }

  async #run(cap: Cap, req: PythonRunRequest): Promise<PythonRunResult> {
    if (typeof req.code !== "string") throw fsError("EINVAL", "python: code is required");
    if (req.fresh) this.stop();
    const root = normalise(req.root ?? "/");
    const cwd = normalise(req.cwd ?? root);
    const { files, synced } = await syncIn(cap, root);
    const engine = await this.#start();
    const id = ++this.#nextRun;
    const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 30_000, 100), 300_000);
    const result = await new Promise<EngineMessage & { type: "result" }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#runs.delete(id);
        this.stop(); // a runaway interpreter cannot be interrupted: replace the engine
        reject(new Error(`ETIMEDOUT: python run exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      this.#runs.set(id, {
        cap,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      engine.post({ type: "run", id, code: req.code, files, cwd });
    });
    return {
      ...(await writeBack(cap, result.changes)),
      stdout: result.stdout,
      stderr: result.stderr,
      value: result.value,
      error: result.error,
      synced,
    };
  }
}

/** The readable files under `root`, as the capability shows them (denied entries are absent). */
async function syncIn(cap: Cap, root: string) {
  const files: Record<string, string> = {};
  let bytes = 0;
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await cap.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const p = join(dir, name);
      let st: { isDirectory?: boolean; isFile?: boolean; size?: number };
      try {
        st = (await cap.call("stat", p)) as typeof st;
      } catch {
        continue;
      }
      if (st.isDirectory) await walk(p);
      else if (st.isFile) {
        if (Object.keys(files).length >= LIMITS.files || bytes + (st.size ?? 0) > LIMITS.bytes) {
          truncated = true;
          return;
        }
        try {
          const text = (await cap.call("readFile", p)) as string;
          files[p] = text;
          bytes += st.size ?? text.length;
        } catch {}
      }
    }
  };
  try {
    const st = (await cap.call("stat", root)) as { isFile?: boolean };
    if (st.isFile) files[root] = (await cap.call("readFile", root)) as string;
    else await walk(root);
  } catch {
    await walk(root); // an ancestor of the rights may be listable without being stat-able
  }
  return { files, synced: { files: Object.keys(files).length, bytes, truncated } };
}

/** Applies a run's changes through the capability; each refused change is reported, not fatal. */
async function writeBack(
  cap: Cap,
  changes: { written: Record<string, string>; binary: string[]; deleted: string[]; dirs: string[] },
) {
  const written: string[] = [];
  const deleted: string[] = [];
  const denied: { path: string; op: string; error: string }[] = [];
  const attempt = async (op: string, path: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (e) {
      denied.push({ path, op, error: String((e as Error)?.message ?? e) });
      return false;
    }
  };
  for (const d of changes.dirs ?? [])
    await attempt("mkdir", d, () => cap.call("mkdir", d, { recursive: true }));
  for (const [p, text] of Object.entries(changes.written ?? {})) {
    if (await attempt("write", p, () => cap.call("writeFile", p, text))) written.push(p);
  }
  for (const p of changes.binary ?? [])
    denied.push({
      path: p,
      op: "write",
      error: "EINVAL: binary data that is not UTF-8 cannot be stored",
    });
  for (const p of changes.deleted ?? []) {
    if (await attempt("delete", p, () => cap.call("rm", p, { recursive: true }))) deleted.push(p);
  }
  return { written, deleted, denied };
}
