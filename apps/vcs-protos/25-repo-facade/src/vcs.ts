/**
 * X16b — the repository façade: one handle over X16a's stores and the layers built on them.
 *
 *  - `openRepository({ files, refFiles } | { db }, { init })`: git files or one SQL database;
 *    `init` makes what `git init --bare` makes (HEAD → refs/heads/<default>, a config with
 *    `core.repositoryformatversion`, `core.bare`, the object and ref directories).
 *  - `config`: git's config file, edited a line at a time (`user.name`/`user.email` are the commit
 *    identity when a commit names none).
 *  - Errors: every method rejects with a `VcsError` whose `code` is stable (`toVcsError` maps the
 *    layers' errors: pack reader, index-pack, ref transactions, transport, gc).
 *  - Cancellation: every long method takes an `AbortSignal` and rejects with ABORTED as soon as it
 *    fires (a source is raced against it; the layers check it between objects); refs change only
 *    in their final transaction, so an abort leaves none changed.
 *  - Hooks: every ref update through the façade — commits, fetches, received pushes (gc changes
 *    none) — runs git's reference-transaction hook (prepared → committed | aborted; a refusal at
 *    prepared rejects the update with CONFLICT); commits run pre-commit, commit-msg, post-commit.
 *  - Leases: a commit and a received push hold X18's gc lease from their first object write to
 *    their ref update.
 */
import type { Db } from "@statewalker/db-api";
import type { FilesApi } from "@statewalker/webrun-files";
import type { RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";
import type { BatchResult, RefCommand, RefDb } from "../../10-ref-transactions/src/ref-db.js";
import { log as readLog, writeFiles } from "../../17-repository/src/commands.js";
import { encodeCommit, type Person } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { fetchFrom } from "../../21-smart-http/src/client.js";
import { push as pushTo } from "../../22-receive-pack/src/client.js";
import { gitHandler } from "../../22-receive-pack/src/server.js";
import { acquireLease, type GcStats, gc as runGc } from "../../24-gc/src/gc.js";
import { GitConfig } from "./config.js";

export type VcsErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "CORRUPT"
  | "PROTOCOL"
  | "ABORTED"
  | "LIMIT"
  | "UNSUPPORTED"
  | "LOCKED"
  | "INVALID"
  | "INTERNAL";

export class VcsError extends Error {
  override name = "VcsError";
  constructor(
    readonly code: VcsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Maps any layer's error to a code (a VcsError is returned as it is). */
export function toVcsError(e: unknown): VcsError {
  if (e instanceof VcsError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const name = err.name;
  // a URL or path in a message says nothing about the failure ("lockdown.git", "abort-test")
  const msg = err.message.replace(URL_RE, "<url>");
  const code = ((): VcsErrorCode => {
    if (name === "AbortError" || name === "TimeoutError") return "ABORTED";
    // a store's limit, whatever layer reports it (index-pack's PackError among them)
    if (/over the limit|exceeds the limit/i.test(msg)) return "LIMIT";
    if (["CorruptObjectError", "PackError", "DeltaError", "ObjectIdMismatchError"].includes(name))
      return "CORRUPT";
    if (name === "PktError") return "PROTOCOL";
    if (err instanceof TypeError && /fetch failed|network|connect/i.test(msg)) return "PROTOCOL";
    if (
      /hash(es|ed) to|id mismatch|corrupt|checksum|CRC|not a pack|trailer|zlib|truncated/i.test(msg)
    )
      return "CORRUPT";
    if (/too large/i.test(msg)) return "LIMIT";
    if (/does not support|unsupported|not supported/i.test(msg)) return "UNSUPPORTED";
    if (/HTTP \d{3}|remote:|does not speak|does not offer|protocol|pkt-line|packet/i.test(msg))
      return "PROTOCOL";
    if (/\.lock\b|\blocked\b/i.test(msg)) return "LOCKED";
    if (/stale|mismatch|fast-forward|declined|refused|conflict/i.test(msg)) return "CONFLICT";
    if (/invalid|funny|bad ref/i.test(msg)) return "INVALID";
    if (/missing|not found|does not match any|no such|^no object/i.test(msg)) return "NOT_FOUND";
    return "INTERNAL";
  })();
  return new VcsError(code, err.message, { cause: e });
}

/** A ref transaction's rejection as a code. */
function rejectionError(res: BatchResult): VcsError {
  const r = res.rejected[0];
  const reason = r?.reason as string | undefined;
  const code: VcsErrorCode =
    reason === "locked"
      ? "LOCKED"
      : reason === "invalid-name" || reason === "duplicate" || reason === "invalid-command"
        ? "INVALID"
        : "CONFLICT";
  return new VcsError(code, `ref update rejected: ${r?.name} (${reason})`);
}

export interface RefUpdate {
  name: string;
  old: string | null;
  new: string | null;
}
export interface Hooks {
  /** git's reference-transaction hook: a string refuses (at "prepared") */
  referenceTransaction?: (
    state: "prepared" | "committed" | "aborted",
    updates: RefUpdate[],
  ) => Promise<string | undefined>;
  /** a string refuses the commit */
  preCommit?: (info: { ref: string; tree: string }) => Promise<string | undefined>;
  /** may return a new message, or throw to refuse */
  commitMsg?: (message: string) => Promise<string | undefined>;
  postCommit?: (oid: string) => Promise<void>;
}

export interface Config {
  get(key: string): string | undefined;
  getAll(key: string): string[];
  set(key: string, value: string): Promise<void>;
  /** the file's text as stored */
  text(): string;
}

export interface CommitOptions {
  ref?: string;
  files?: Record<string, Uint8Array>;
  tree?: string;
  parents?: string[];
  message: string;
  author?: Person;
  signal?: AbortSignal;
}

export interface Vcs {
  /** the underlying repository; its refs run the hooks */
  repo: Repository;
  config: Config;
  commit(opts: CommitOptions): Promise<string>;
  log(ref: string): Promise<string[]>;
  updateRefs(commands: RefCommand[], opts?: { signal?: AbortSignal }): Promise<void>;
  fetch(
    url: string,
    opts?: { refspecs?: string[]; signal?: AbortSignal; fetch?: typeof fetch },
  ): Promise<void>;
  push(
    url: string,
    opts: { refspecs: string[]; signal?: AbortSignal; fetch?: typeof fetch },
  ): Promise<{ ref: string; ok: boolean; reason?: string }[]>;
  /** X18's gc: `deferred` when a writer's lease or another sweep made it stop */
  gc(opts?: {
    graceMs?: number;
    signal?: AbortSignal;
  }): Promise<{ deferred: boolean; stats: GcStats }>;
  installPack(source: AsyncIterable<Uint8Array>, opts?: { signal?: AbortSignal }): Promise<string>;
  /** git's smart HTTP for this repository (hooks and gc leases on received pushes) */
  serve(): (req: Request) => Promise<Response>;
}

export interface OpenOptions {
  init?: boolean;
  defaultBranch?: string;
  hooks?: Hooks;
  /** used when a commit names no author and the config has no user.name/user.email */
  identity?: { name: string; email: string };
  maxPackSize?: number;
  now?: () => number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const abortReason = (signal: AbortSignal) =>
  signal.reason ?? new DOMException("aborted", "AbortError");

/** `source`, its every step raced against `signal` (a stalled source is left at once). */
async function* abortable(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!signal) {
    yield* source;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}

/** `p`, rejected as soon as `signal` fires. */
function raced<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(abortReason(signal));
    signal.addEventListener("abort", fail, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}

/**
 * A RefDb whose batches run the reference-transaction hook (git's: the named ref and, through a
 * symbolic ref, its target; errors of the committed/aborted calls ignored, as git ignores those
 * hooks' status) and stop once `signal` has fired.
 */
function hookedRefs(inner: RefDb, hooks: Hooks, signal?: AbortSignal): RefDb {
  const rt = hooks.referenceTransaction;
  if (!rt && !signal) return inner;
  const tell = async (state: "committed" | "aborted", updates: RefUpdate[]) => {
    await rt?.(state, updates).catch(() => undefined);
  };
  return {
    read: (n) => inner.read(n),
    resolve: (n) => inner.resolve(n),
    list: (p) => inner.list(p),
    setSymref: (n, t, e) => inner.setSymref(n, t, e),
    reflog: (n) => inner.reflog(n),
    async batch(commands, o) {
      signal?.throwIfAborted();
      const updates: RefUpdate[] = [];
      for (const c of commands) {
        const current = (await inner.resolve(c.name)) ?? null;
        updates.push({ name: c.name, old: c.old !== undefined ? c.old : current, new: c.new });
        if (c.noDeref) continue;
        let target = c.name;
        for (let depth = 0; depth < 5; depth++) {
          const v = await inner.read(target);
          if (!v || !("symref" in v)) break;
          target = v.symref;
        }
        if (target !== c.name)
          updates.push({ name: target, old: c.old !== undefined ? c.old : current, new: c.new });
      }
      let refusal: string | undefined;
      try {
        refusal = await rt?.("prepared", updates);
      } catch (e) {
        refusal = String(e);
      }
      if (refusal || signal?.aborted) {
        await tell("aborted", updates);
        signal?.throwIfAborted();
        return {
          ok: false,
          rejected: commands.map((c) => ({ name: c.name, reason: "hook" as never })),
        };
      }
      let res: BatchResult;
      try {
        res = await inner.batch(commands, o);
      } catch (e) {
        await tell("aborted", updates);
        throw e;
      }
      await tell(res.ok ? "committed" : "aborted", updates);
      return res;
    },
  };
}

/** Runs `f`; its error as a VcsError (ABORTED, whatever the error, once `signal` has fired). */
async function wrap<T>(f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (signal?.aborted && !(e instanceof VcsError && e.code === "ABORTED"))
      throw new VcsError("ABORTED", `aborted: ${String(signal.reason)}`, { cause: signal.reason });
    throw toVcsError(e);
  }
}

type Spec = { files: FilesApi; refFiles: RefFiles } | { db: Db };

export async function openRepository(spec: Spec, opts: OpenOptions = {}): Promise<Vcs> {
  try {
    return await open(spec, opts);
  } catch (e) {
    throw toVcsError(e);
  }
}

async function open(spec: Spec, opts: OpenOptions): Promise<Vcs> {
  const hooks = opts.hooks ?? {};
  const branch = opts.defaultBranch ?? "main";
  const base: Repository =
    "db" in spec
      ? await sqlRepository(spec.db, { maxPackSize: opts.maxPackSize })
      : await filesRepository(spec.files, spec.refFiles, { maxPackSize: opts.maxPackSize });
  const access = base.objects.gc;
  if (!access) throw new VcsError("UNSUPPORTED", "this store has no files for config and gc");
  const files = access.files;
  const configPath = access.root ? `${access.root}/config` : "config";
  const readConfig = async () => {
    if (!(await files.exists(configPath))) return "";
    const parts: Uint8Array[] = [];
    for await (const c of files.read(configPath)) parts.push(c);
    return dec.decode(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
  };
  const lockPath = `${configPath}.lock`;
  /** git's config.lock: taken (or LOCKED), written, renamed over the file */
  const writeConfig = async (edit: (text: string) => string) => {
    if (await files.exists(lockPath))
      throw new VcsError("LOCKED", `${lockPath} exists: another process is editing the config`);
    await files.write(lockPath, [enc.encode("")]);
    try {
      await files.write(lockPath, [enc.encode(edit(await readConfig()))]);
      await files.move(lockPath, configPath);
    } catch (e) {
      await files.remove(lockPath).catch(() => false);
      throw e;
    }
  };
  if (opts.init) {
    if (!(await base.refs.read("HEAD"))) await base.refs.setSymref("HEAD", `refs/heads/${branch}`);
    if (!(await files.exists(configPath)))
      await writeConfig(
        () => "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
      );
    if ("files" in spec) {
      const at = (d: string) => (access.root ? `${access.root}/${d}` : d);
      for (const d of ["objects/pack", "objects/info", "refs/heads", "refs/tags", "hooks", "info"])
        await files.mkdir(at(d)).catch(() => {});
      // git's default template (its hook samples are left out: they are inert)
      for (const [f, text] of [
        [
          "description",
          "Unnamed repository; edit this file 'description' to name the repository.\n",
        ],
        [
          "info/exclude",
          "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n",
        ],
      ] as const)
        if (!(await files.exists(at(f)))) await files.write(at(f), [enc.encode(text)]);
    }
  }
  let cfg = new GitConfig(await readConfig());
  const config: Config = {
    get: (k) => cfg.get(k),
    getAll: (k) => cfg.getAll(k),
    set: (k, v) =>
      wrap(() =>
        writeConfig((text) => {
          // edited on the file as it is now: other writers' changes are kept
          const fresh = new GitConfig(text);
          fresh.set(k, v);
          cfg = fresh;
          return fresh.text();
        }),
      ),
    text: () => cfg.text(),
  };
  const repo: Repository = { objects: base.objects, refs: hookedRefs(base.refs, hooks) };
  /** the repository for one operation: its ref updates stop once `signal` has fired */
  const scoped = (signal?: AbortSignal): Repository =>
    signal ? { objects: base.objects, refs: hookedRefs(base.refs, hooks, signal) } : repo;
  const now = opts.now ?? Date.now;
  const identity = (): Person => {
    const name = cfg.get("user.name") ?? opts.identity?.name;
    const email = cfg.get("user.email") ?? opts.identity?.email;
    if (!name || !email)
      throw new VcsError("INVALID", "no identity: set user.name and user.email, or pass one");
    return { name, email, when: Math.floor(now() / 1000), tz: "+0000" };
  };
  // gc runs one at a time: an aborted run is left to stop at its next check before the next starts
  let gcChain: Promise<unknown> = Promise.resolve();

  return {
    repo,
    config,
    commit: (o) =>
      wrap(async () => {
        o.signal?.throwIfAborted();
        const r = scoped(o.signal);
        const head = await r.refs.read("HEAD");
        // git commits onto HEAD: its branch, or HEAD itself when detached
        const detached = !o.ref && head !== undefined && "oid" in head;
        const ref =
          o.ref ??
          (head && "symref" in head ? head.symref : detached ? "HEAD" : `refs/heads/${branch}`);
        const author = o.author ?? identity();
        const lease = await acquireLease(r, { signal: o.signal });
        try {
          const tip = await r.refs.resolve(ref);
          const parents = o.parents ?? (tip ? [tip] : []);
          for (const p of parents)
            if (!(await r.objects.has(p)))
              throw new VcsError("NOT_FOUND", `parent ${p} is missing`);
          const tree = o.tree ?? (await writeFiles(r, o.files ?? {}));
          o.signal?.throwIfAborted();
          const refused = await hooks.preCommit?.({ ref, tree });
          if (refused) throw new VcsError("CONFLICT", `pre-commit declined: ${refused}`);
          let message = o.message;
          try {
            message = (await hooks.commitMsg?.(o.message)) ?? o.message;
          } catch (e) {
            throw new VcsError("CONFLICT", `commit-msg declined: ${String(e)}`, { cause: e });
          }
          o.signal?.throwIfAborted();
          const oid = await r.objects.put(
            "commit",
            encodeCommit({ tree, parents, author, committer: author, message }),
          );
          const res = await r.refs.batch(
            [{ name: ref, old: tip ?? null, new: oid, noDeref: detached || undefined }],
            { message: `commit: ${message.split("\n")[0]}` },
          );
          if (!res.ok) throw rejectionError(res);
          // git ignores post-commit's status: the commit is made
          await Promise.resolve(hooks.postCommit?.(oid)).catch(() => undefined);
          return oid;
        } finally {
          await lease.release();
        }
      }, o.signal),
    log: (ref) => wrap(() => readLog(repo, ref)),
    updateRefs: (commands, o) =>
      wrap(async () => {
        const res = await scoped(o?.signal).refs.batch(commands);
        if (!res.ok) throw rejectionError(res);
      }, o?.signal),
    fetch: (url, o = {}) =>
      wrap(async () => {
        const r = await raced(
          fetchFrom(url, scoped(o.signal), {
            refspecs: o.refspecs,
            signal: o.signal,
            fetch: o.fetch,
          }),
          o.signal,
        );
        if (r.rejected.length)
          throw new VcsError(
            "CONFLICT",
            `refs not updated: ${r.rejected.map((x) => `${x.name} (${x.reason})`).join(", ")}`,
          );
      }, o.signal),
    push: (url, o) =>
      wrap(
        () =>
          raced(
            pushTo(url, repo, { refspecs: o.refspecs, signal: o.signal, fetch: o.fetch }),
            o.signal,
          ),
        o.signal,
      ),
    gc: (o = {}) =>
      wrap(async () => {
        o.signal?.throwIfAborted();
        const run = gcChain.then(() => runGc(repo, { graceMs: o.graceMs, signal: o.signal }));
        gcChain = run.catch(() => undefined);
        const step = await raced(run, o.signal);
        return { deferred: step.deferred === true, stats: step.stats };
      }, o.signal),
    installPack: (source, o = {}) =>
      wrap(async () => {
        o.signal?.throwIfAborted();
        return (await repo.objects.installPack(abortable(source, o.signal))).packId;
      }, o.signal),
    serve() {
      const handler = gitHandler(repo);
      return async (req) => {
        const url = new URL(req.url);
        if (req.method !== "POST" || !url.pathname.endsWith("/git-receive-pack"))
          return handler(req);
        // a received push holds gc's lease until its response (the report) has been sent
        const lease = await acquireLease(repo, { signal: req.signal });
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          req.signal.removeEventListener("abort", onGone);
          await lease.release();
        };
        // a client gone before reading the report does not hold the lease
        const onGone = () => void release();
        req.signal.addEventListener("abort", onGone, { once: true });
        let res: Response;
        try {
          res = await handler(req);
        } catch (e) {
          await release();
          throw e;
        }
        if (!res.body) {
          await release();
          return res;
        }
        const reader = res.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            try {
              const r = await reader.read();
              if (r.done) {
                await release();
                ctrl.close();
              } else ctrl.enqueue(r.value);
            } catch (e) {
              await release();
              ctrl.error(e);
            }
          },
          async cancel(reason) {
            await release();
            await reader.cancel(reason);
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      };
    },
  };
}
