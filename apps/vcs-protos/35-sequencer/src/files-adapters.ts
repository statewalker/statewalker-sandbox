/**
 * X15 — a FilesApi seen from a subdirectory, and X5's RefFiles over any FilesApi, so a whole
 * repository (worktree, `.git`, refs, state files) lives in one FilesApi and survives a reload.
 * Changes go through one queue per instance, so `createExclusive` is exclusive among the calls of
 * one process (two async batches in one tab); across processes or tabs, X2's adapters (Web Locks,
 * O_EXCL) give exclusive creation.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";

const join = (prefix: string, path: string) =>
  `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;

/** the FilesApi under `prefix`, with paths relative to it */
export function subFiles(files: FilesApi, prefix: string): FilesApi {
  const p = (path: string) => join(prefix, path);
  const strip = (path: string) => {
    const base = prefix.replace(/\/$/, "");
    return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
  };
  return {
    read: (path, o) => files.read(p(path), o),
    write: (path, content) => files.write(p(path), content),
    mkdir: (path) => files.mkdir(p(path)),
    async *list(path, o) {
      for await (const e of files.list(p(path), o)) yield { ...e, path: strip(e.path) };
    },
    async stats(path) {
      return files.stats(p(path));
    },
    exists: (path) => files.exists(p(path)),
    remove: (path) => files.remove(p(path)),
    move: (a, b) => files.move(p(a), p(b)),
    copy: (a, b) => files.copy(p(a), p(b)),
  } as FilesApi;
}

/** X5's RefFiles on a FilesApi rooted at a git directory */
export function filesRefFiles(files: FilesApi): RefFiles {
  const abs = (path: string) => join("/", path);
  const readAll = async (path: string) => {
    const parts: Uint8Array[] = [];
    for await (const c of files.read(abs(path))) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of parts) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  const isFile = async (path: string) => (await files.stats(abs(path)))?.kind === "file";
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    async *read(path) {
      if (await isFile(path)) yield await readAll(path);
    },
    exists: isFile,
    remove: (path) =>
      serial(async () => {
        if (!(await isFile(path))) return false;
        return files.remove(abs(path));
      }),
    createExclusive: (path, content) =>
      serial(async () => {
        if (await files.exists(abs(path))) return false;
        await files.write(abs(path), [content]);
        return true;
      }),
    replace: (source, target) =>
      serial(async () => {
        const bytes = await readAll(source);
        await files.write(abs(target), [bytes]);
        await files.remove(abs(source));
      }),
    write: (path, content) => serial(() => files.write(abs(path), [content])),
    async *list(dir) {
      const out: string[] = [];
      for await (const e of files.list(abs(dir), { recursive: true }))
        if (e.kind === "file") out.push(e.path.replace(/^\//, ""));
      yield* out.sort();
    },
    append: (path, content) =>
      serial(async () => {
        const old = (await isFile(path)) ? await readAll(path) : new Uint8Array(0);
        const next = new Uint8Array(old.length + content.length);
        next.set(old);
        next.set(content, old.length);
        await files.write(abs(path), [next]);
      }),
    removeEmptyDir: (dir) =>
      serial(async () => {
        const st = await files.stats(abs(dir));
        if (st?.kind !== "directory") return false;
        for await (const _ of files.list(abs(dir))) return false;
        return files.remove(abs(dir));
      }),
  };
}
