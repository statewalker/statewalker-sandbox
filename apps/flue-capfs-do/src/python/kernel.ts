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
  /** More than the write-back limits (5000 files, 16 MB) was produced: the rest was dropped. */
  truncated: boolean;
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
  | { type: "cap"; id: number; run: number | null; method: string; args: unknown[] }
  | {
      type: "result";
      id: number;
      stdout: string;
      stderr: string;
      value: unknown;
      error?: string;
      changes: Changes;
    };

/** A file's content between the kernel and the engine: UTF-8 text, or other bytes as base64. */
type Content = string | { $b64: string };
type Changes = {
  written: Record<string, Content>;
  deleted: string[];
  dirs: string[];
  /** The topmost directory of each removed tree. */
  deletedDirs?: string[];
  truncated?: boolean;
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
  /** The capability (its revocation id) the current engine serves: one engine per capability. */
  #owner?: string;

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
    this.#owner = undefined;
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

  /**
   * A live `capfs` call from Python: only the file methods, answered with the capability of the
   * run the call names. A call naming no active run (a task an earlier run left behind) is
   * refused, never served with another run's capability.
   */
  async #answerCap(m: EngineMessage & { type: "cap" }) {
    const run = typeof m.run === "number" ? this.#runs.get(m.run) : undefined;
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
    // One engine per capability: state a run leaves in the interpreter (files outside
    // /workspace, patched builtins, tasks) is never seen by a run holding another capability.
    const owner = await cap.revocationId();
    if (req.fresh || this.#owner !== owner) this.stop();
    const root = normalise(req.root ?? "/");
    const cwd = normalise(req.cwd ?? root);
    const { files, synced } = await syncIn(cap, root);
    const engine = await this.#start();
    this.#owner = owner;
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
  const files: Record<string, Content> = {};
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
          const b = toBytes(await cap.call("readFileBuffer", p));
          files[p] = toContent(b);
          bytes += b.length;
        } catch {}
      }
    }
  };
  try {
    const st = (await cap.call("stat", root)) as { isFile?: boolean };
    if (st.isFile) files[root] = toContent(toBytes(await cap.call("readFileBuffer", root)));
    else await walk(root);
  } catch {
    await walk(root); // an ancestor of the rights may be listable without being stat-able
  }
  return { files, synced: { files: Object.keys(files).length, bytes, truncated } };
}

const toBytes = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** UTF-8 files travel as text, others as base64 (the Node engine's IPC is JSON). */
function toContent(b: Uint8Array): Content {
  try {
    return strictUtf8.decode(b);
  } catch {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000)
      s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { $b64: btoa(s) };
  }
}
/** The bytes a Content stands for; undefined if it is neither form. */
function fromContent(c: unknown): Uint8Array | undefined {
  if (typeof c === "string") return new TextEncoder().encode(c);
  if (c && typeof c === "object" && typeof (c as { $b64?: unknown }).$b64 === "string") {
    try {
      return Uint8Array.from(atob((c as { $b64: string }).$b64), (ch) => ch.charCodeAt(0));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Applies a run's changes through the capability; each refused change is reported, not fatal.
 * The engine is untrusted once user code has run, so its report is bounded and checked here
 * too; every path goes through the capability (normalised and authorized there).
 */
async function writeBack(cap: Cap, changes: Changes) {
  const written: string[] = [];
  const deleted: string[] = [];
  const denied: { path: string; op: string; error: string }[] = [];
  let truncated = !!changes?.truncated;
  const attempt = async (op: string, path: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (e) {
      denied.push({ path, op, error: String((e as Error)?.message ?? e) });
      return false;
    }
  };
  const list = (v: unknown) =>
    (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []).slice(
      0,
      LIMITS.files,
    );
  for (const d of list(changes?.dirs))
    await attempt("mkdir", d, () => cap.call("mkdir", d, { recursive: true }));
  let files = 0;
  let bytes = 0;
  for (const [p, content] of Object.entries(changes?.written ?? {})) {
    const b = fromContent(content);
    if (!b) continue;
    files += 1;
    bytes += b.length;
    if (files > LIMITS.files || bytes > LIMITS.bytes) {
      truncated = true;
      break;
    }
    // Text as text, binary content byte for byte.
    const write =
      typeof content === "string"
        ? () => cap.call("writeFile", p, content)
        : () => cap.call("writeFileBuffer", p, b);
    if (await attempt("write", p, write)) written.push(p);
  }
  // Removed trees: one recursive rm each; then the single files outside them.
  const goneDirs = list(changes?.deletedDirs);
  for (const d of goneDirs) {
    if (await attempt("delete", d, () => cap.call("rm", d, { recursive: true }))) deleted.push(d);
  }
  for (const p of list(changes?.deleted)) {
    if (goneDirs.some((d) => p.startsWith(`${d}/`))) continue;
    if (await attempt("delete", p, () => cap.call("rm", p, {}))) deleted.push(p);
  }
  return { written, deleted, denied, truncated };
}
