// The owner side of streaming: a @statewalker/webrun-files FilesApi over the store, as one
// capability (token) may use it. Every operation goes through FsGate, in the owner cell: each
// path is authorized, and a stream is authorized again on every block it reads or writes, so a
// revocation or a mode change stops it between two blocks. The Workspace serves it to holders
// with a webrun-files-rpc server per token (src/files-rpc.ts); holders use the files-RPC client.
//
//   read(path)   store openRead → readChunk … (empty block: the end) → closeRead
//   write(path)  store openWrite → writeChunk … → commitWrite (abortWrite when the content
//                fails or is aborted); the file changes at commit, all at once
//   append(path) the same with the store's append stream: the commit rewrites only the file's
//                last block (in place when the file alone owns its content), and fails with
//                ESTALE if the file changed since the append began (webrun-files-rpc's
//                AppendableFilesApi: the files-RPC server appends through it)
//
// FilesApi semantics: a missing file (or a directory) reads as nothing; `move`/`copy` take the
// exact new path and replace what is there; `remove` and `mkdir` are recursive.

import type { ListOptions, ReadOptions } from "@statewalker/webrun-files";
import { type FileInfo, type FileStats, listInPathOrder } from "@statewalker/webrun-files";
import type { AppendableFilesApi } from "@statewalker/webrun-files-rpc";
import type { FsGate } from "./authority.ts";
import { normalise } from "./path.ts";
import { BLOCK_BYTES, type DirEntryStat } from "./sql-fs.ts";

const codeOf = (e: unknown) =>
  (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(String((e as Error)?.message ?? e))?.[1];
const toBytes = (v: unknown) =>
  v instanceof Uint8Array
    ? v
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : new Uint8Array(v as ArrayBuffer);
/** The store's normal form ("." and ".." resolved): the one FsGate authorizes. */
const norm = (p: string) => normalise(p);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

export class GuardedFilesApi implements AppendableFilesApi {
  #gate: FsGate;
  constructor(gate: FsGate) {
    this.#gate = gate;
  }

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const p = norm(path);
    let id: string;
    try {
      ({ id } = (await this.#gate.stream("openRead", p, {
        start: options.start,
        length: options.length,
      })) as { id: string });
    } catch (e) {
      if (codeOf(e) === "ENOENT" || codeOf(e) === "EISDIR") return;
      throw e;
    }
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const block = toBytes(await this.#gate.stream("readChunk", p, id, BLOCK_BYTES));
        if (!block.length) return;
        yield block;
      }
    } finally {
      await this.#gate.stream("closeRead", p, id).catch(() => {});
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    return this.#write(path, content, false);
  }

  async append(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    return this.#write(path, content, true);
  }

  async #write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    append: boolean,
  ): Promise<void> {
    const p = norm(path);
    const { id } = (await this.#gate.stream("openWrite", p, { append })) as { id: string };
    try {
      for await (const chunk of content as AsyncIterable<Uint8Array>) {
        const b = toBytes(chunk);
        for (let at = 0; at < b.length; at += BLOCK_BYTES)
          await this.#gate.stream("writeChunk", p, id, b.subarray(at, at + BLOCK_BYTES));
      }
      await this.#gate.stream("commitWrite", p, id);
    } catch (e) {
      await this.#gate.stream("abortWrite", p, id).catch(() => {});
      throw e;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#gate.call("mkdir", norm(path), { recursive: true });
  }

  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const root = norm(path);
    const st = await this.stats(root);
    if (st?.kind !== "directory") return;
    const children = async (dir: string): Promise<FileInfo[]> => {
      let entries: DirEntryStat[];
      try {
        entries = await this.#gate.readdirStat(dir);
      } catch {
        return []; // a directory the token cannot list shows as empty
      }
      return entries.map((e) =>
        e.isDirectory
          ? { kind: "directory", name: e.name, path: join(dir, e.name) }
          : {
              kind: "file",
              name: e.name,
              path: join(dir, e.name),
              size: e.size,
              lastModified: Date.parse(e.mtime) || 0,
            },
      );
    };
    yield* listInPathOrder(root, children, options);
  }

  async stats(path: string): Promise<FileStats | undefined> {
    try {
      const s = (await this.#gate.call("stat", norm(path))) as {
        isDirectory: boolean;
        size: number;
        mtime: string;
      };
      return s.isDirectory
        ? { kind: "directory" }
        : { kind: "file", size: s.size, lastModified: Date.parse(s.mtime) || 0 };
    } catch (e) {
      if (codeOf(e) === "ENOENT") return undefined;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    await this.#gate.call("rm", norm(path), { recursive: true });
    return true;
  }

  /** `target` is the exact new path (not a directory to move into, as with `mv`). */
  async move(source: string, target: string): Promise<boolean> {
    return this.#transfer("mv", source, target);
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#transfer("cp", source, target);
  }

  async #transfer(kind: "cp" | "mv", source: string, target: string): Promise<boolean> {
    const from = norm(source);
    const to = norm(target);
    if (!(await this.exists(from))) return false;
    if (from === to) return true;
    if (await this.exists(to)) await this.#gate.call("rm", to, { recursive: true });
    await this.#gate.move(kind, from, to, { recursive: true });
    return true;
  }
}
