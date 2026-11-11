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
import { acquireLease, gc as runGc } from "../../24-gc/src/gc.js";
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

/** Maps any layer's error to a code (a VcsError is returned as it is). */
export function toVcsError(e: unknown): VcsError {
  if (e instanceof VcsError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const name = err.name;
  const msg = err.message;
  const code = ((): VcsErrorCode => {
    if (name === "AbortError" || name === "TimeoutError" || /\babort/i.test(msg)) return "ABORTED";
    if (/over the limit|exceeds the limit|too large/i.test(msg)) return "LIMIT";
    if (/does not support|unsupported|not supported/i.test(msg)) return "UNSUPPORTED";
    if (
      name === "PktError" ||
      /HTTP \d{3}|remote:|does not speak|protocol|pkt-line|packet/i.test(msg)
    )
      return "PROTOCOL";
    if (
      name === "PackError" ||
      name === "DeltaError" ||
      /corrupt|hashes to|checksum|CRC|not a pack|trailer/i.test(msg)
    )
      return "CORRUPT";
    if (/\block/i.test(msg)) return "LOCKED";
    if (/stale|mismatch|fast-forward|declined|refused|conflict/i.test(msg)) return "CONFLICT";
    if (/invalid|funny|bad ref/i.test(msg)) return "INVALID";
    if (/missing|not found|does not match any|no such/i.test(msg)) return "NOT_FOUND";
    return "INTERNAL";
  })();
  return new VcsError(code, msg, { cause: e });
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
  gc(opts?: { graceMs?: number; signal?: AbortSignal }): Promise<void>;
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

/** A RefDb whose batches run the reference-transaction hook. */
function hookedRefs(inner: RefDb, hooks: Hooks): RefDb {
  const rt = hooks.referenceTransaction;
  if (!rt) return inner;
  return {
    read: (n) => inner.read(n),
    resolve: (n) => inner.resolve(n),
    list: (p) => inner.list(p),
    setSymref: (n, t, e) => inner.setSymref(n, t, e),
    reflog: (n) => inner.reflog(n),
    async batch(commands, o) {
      const updates: RefUpdate[] = [];
      for (const c of commands)
        updates.push({
          name: c.name,
          old: c.old !== undefined ? c.old : ((await inner.resolve(c.name)) ?? null),
          new: c.new,
        });
      const refusal = await rt("prepared", updates);
      if (refusal) {
        await rt("aborted", updates);
        return {
          ok: false,
          rejected: commands.map((c) => ({ name: c.name, reason: "hook" as never })),
        };
      }
      let res: BatchResult;
      try {
        res = await inner.batch(commands, o);
      } catch (e) {
        await rt("aborted", updates);
        throw e;
      }
      await rt(res.ok ? "committed" : "aborted", updates);
      return res;
    },
  };
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
  const writeConfig = async (text: string) => {
    // git's config.lock, renamed over the file
    const tmp = `${configPath}.lock`;
    await files.write(tmp, [enc.encode(text)]);
    await files.move(tmp, configPath);
  };
  if (opts.init) {
    if (!(await base.refs.read("HEAD"))) await base.refs.setSymref("HEAD", `refs/heads/${branch}`);
    if (!(await files.exists(configPath)))
      await writeConfig(
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
      );
    if ("files" in spec)
      for (const d of ["objects/pack", "objects/info", "refs/heads", "refs/tags"])
        await files.mkdir(access.root ? `${access.root}/${d}` : d).catch(() => {});
  }
  const cfg = new GitConfig(await readConfig());
  const config: Config = {
    get: (k) => cfg.get(k),
    getAll: (k) => cfg.getAll(k),
    async set(k, v) {
      cfg.set(k, v);
      await writeConfig(cfg.text());
    },
    text: () => cfg.text(),
  };
  const repo: Repository = { objects: base.objects, refs: hookedRefs(base.refs, hooks) };
  const now = opts.now ?? Date.now;
  const identity = (): Person => {
    const name = cfg.get("user.name") ?? opts.identity?.name;
    const email = cfg.get("user.email") ?? opts.identity?.email;
    if (!name || !email)
      throw new VcsError("INVALID", "no identity: set user.name and user.email, or pass one");
    return { name, email, when: Math.floor(now() / 1000), tz: "+0000" };
  };
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw toVcsError(e);
    }
  };

  return {
    repo,
    config,
    commit: (o) =>
      wrap(async () => {
        o.signal?.throwIfAborted();
        const head = await repo.refs.read("HEAD");
        const ref = o.ref ?? (head && "symref" in head ? head.symref : `refs/heads/${branch}`);
        const author = o.author ?? identity();
        const lease = await acquireLease(repo, { signal: o.signal });
        try {
          const tip = await repo.refs.resolve(ref);
          const parents = o.parents ?? (tip ? [tip] : []);
          for (const p of parents)
            if (!(await repo.objects.has(p)))
              throw new VcsError("NOT_FOUND", `parent ${p} is missing`);
          const tree = o.tree ?? (await writeFiles(repo, o.files ?? {}));
          o.signal?.throwIfAborted();
          const refused = await hooks.preCommit?.({ ref, tree });
          if (refused) throw new VcsError("CONFLICT", `pre-commit declined: ${refused}`);
          const message = (await hooks.commitMsg?.(o.message)) ?? o.message;
          o.signal?.throwIfAborted();
          const oid = await repo.objects.put(
            "commit",
            encodeCommit({ tree, parents, author, committer: author, message }),
          );
          o.signal?.throwIfAborted();
          const res = await repo.refs.batch([{ name: ref, old: tip ?? null, new: oid }], {
            message: `commit: ${message.split("\n")[0]}`,
          });
          if (!res.ok) throw rejectionError(res);
          await hooks.postCommit?.(oid);
          return oid;
        } finally {
          await lease.release();
        }
      }),
    log: (ref) => wrap(() => readLog(repo, ref)),
    updateRefs: (commands, o) =>
      wrap(async () => {
        o?.signal?.throwIfAborted();
        const res = await repo.refs.batch(commands);
        if (!res.ok) throw rejectionError(res);
      }),
    fetch: (url, o = {}) =>
      wrap(async () => {
        const r = await raced(
          fetchFrom(url, repo, { refspecs: o.refspecs, signal: o.signal, fetch: o.fetch }),
          o.signal,
        );
        if (r.rejected.length)
          throw new VcsError(
            "CONFLICT",
            `refs not updated: ${r.rejected.map((x) => `${x.name} (${x.reason})`).join(", ")}`,
          );
      }),
    push: (url, o) =>
      wrap(() =>
        raced(
          pushTo(url, repo, { refspecs: o.refspecs, signal: o.signal, fetch: o.fetch }),
          o.signal,
        ),
      ),
    gc: (o = {}) =>
      wrap(async () => {
        await raced(runGc(repo, { graceMs: o.graceMs, signal: o.signal }), o.signal);
      }),
    installPack: (source, o = {}) =>
      wrap(async () => {
        o.signal?.throwIfAborted();
        return (await repo.objects.installPack(abortable(source, o.signal))).packId;
      }),
    serve() {
      const handler = gitHandler(repo);
      return async (req) => {
        const url = new URL(req.url);
        if (req.method !== "POST" || !url.pathname.endsWith("/git-receive-pack"))
          return handler(req);
        // a received push holds gc's lease until its response (the report) has been sent
        const lease = await acquireLease(repo);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          await lease.release();
        };
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
