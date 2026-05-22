import type { FilesApi } from "@statewalker/webrun-files";
import { joinPath, normalizePath, readText, writeText } from "@statewalker/webrun-files";
import type {
  BufferEncoding,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";

// `DirentEntry`, `ReadFileOptions`, `WriteFileOptions` are not re-exported
// from `just-bash`'s public surface (only from the deep `dist/fs/interface.js`
// path which we don't import). Hand-rolling the shape works because the
// fields are stable and our adapter ignores options.
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
type ReadFileOptions = unknown;
type WriteFileOptions = unknown;

export interface FilesApiAdapterOptions {
  files: FilesApi;
  /**
   * Default cwd this adapter resolves relative paths against when bash
   * asks `resolvePath` with an empty base. `just-bash` typically supplies
   * an explicit base, so this only matters for direct callers.
   */
  cwd?: string;
}

class ENOENT extends Error {
  code = "ENOENT";
  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`);
    this.name = "ENOENT";
  }
}

class ENOSYS extends Error {
  code = "ENOSYS";
  constructor(op: string) {
    super(`ENOSYS: function not implemented: '${op}' is not supported by FilesApiAdapter`);
    this.name = "ENOSYS";
  }
}

/**
 * `IFileSystem` adapter that transcodes calls from `just-bash`'s
 * shape onto the `FilesApi` from `@statewalker/webrun-files`.
 *
 * Symlinks, permissions, and timestamps are not modelled by `FilesApi`,
 * so the operations that read or write them either degrade gracefully
 * (e.g. lstat = stat, realpath = path) or throw `ENOSYS` (`symlink`,
 * `link`, `readlink`, `chmod`, `utimes`).
 */
export class FilesApiAdapter implements IFileSystem {
  readonly files: FilesApi;
  readonly cwd: string;

  constructor(opts: FilesApiAdapterOptions) {
    this.files = opts.files;
    this.cwd = normalizePath(opts.cwd ?? "/");
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(joinPath(base || this.cwd, path));
  }

  // ── reads ─────────────────────────────────────────────────────────
  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const p = normalizePath(path);
    if (!(await this.files.exists(p))) throw new ENOENT(p);
    const text = await readText(this.files, p);
    // ReadFileOptions in just-bash carries an encoding; we always decode as UTF-8.
    // Passing an explicit non-utf-8 encoding falls back to the bytes-as-string shape.
    void options;
    return text;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (!(await this.files.exists(p))) throw new ENOENT(p);
    return concatChunks(this.files.read(p));
  }

  // ── writes ────────────────────────────────────────────────────────
  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const p = normalizePath(path);
    if (typeof content === "string") {
      await writeText(this.files, p, content);
    } else {
      await this.files.write(p, [content]);
    }
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const p = normalizePath(path);
    // Read the existing file as bytes, append the new chunk as bytes, write
    // bytes. Going through a UTF-8 string round-trip would corrupt binary
    // files (replacement chars on invalid sequences) and even garble plain
    // ASCII appended to a binary file.
    const incoming = typeof content === "string" ? new TextEncoder().encode(content) : content;
    let next: Uint8Array;
    if (await this.files.exists(p)) {
      const existing = await concatChunks(this.files.read(p));
      next = new Uint8Array(existing.byteLength + incoming.byteLength);
      next.set(existing, 0);
      next.set(incoming, existing.byteLength);
    } else {
      next = incoming;
    }
    await this.files.write(p, [next]);
  }

  // ── metadata ──────────────────────────────────────────────────────
  async stat(path: string): Promise<FsStat> {
    const p = normalizePath(path);
    const s = await this.files.stats(p);
    if (!s) throw new ENOENT(p);
    return {
      isFile: s.kind === "file",
      isDirectory: s.kind === "directory",
      isSymbolicLink: false,
      mode: 0o644,
      size: s.size ?? 0,
      mtime: s.lastModified != null ? new Date(s.lastModified) : new Date(0),
    };
  }

  lstat(path: string): Promise<FsStat> {
    // No symlinks in FilesApi — lstat is equivalent to stat.
    return this.stat(path);
  }

  async realpath(path: string): Promise<string> {
    const p = normalizePath(path);
    if (!(await this.files.exists(p))) throw new ENOENT(p);
    return p;
  }

  exists(path: string): Promise<boolean> {
    return this.files.exists(normalizePath(path));
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);
    if (!(await this.files.exists(p))) throw new ENOENT(p);
    const out: string[] = [];
    for await (const e of this.files.list(p)) out.push(e.name);
    return out;
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const p = normalizePath(path);
    if (!(await this.files.exists(p))) throw new ENOENT(p);
    const out: DirentEntry[] = [];
    for await (const e of this.files.list(p)) {
      out.push({
        name: e.name,
        isFile: e.kind === "file",
        isDirectory: e.kind === "directory",
        isSymbolicLink: false,
      });
    }
    return out;
  }

  // ── mutation ──────────────────────────────────────────────────────
  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    // FilesApi.mkdir is always recursive — option is accepted for shape parity.
    await this.files.mkdir(normalizePath(path));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    const removed = await this.files.remove(p);
    if (!removed && !options?.force) throw new ENOENT(p);
  }

  async cp(src: string, dest: string): Promise<void> {
    const ok = await this.files.copy(normalizePath(src), normalizePath(dest));
    if (!ok) throw new ENOENT(src);
  }

  async mv(src: string, dest: string): Promise<void> {
    const ok = await this.files.move(normalizePath(src), normalizePath(dest));
    if (!ok) throw new ENOENT(src);
  }

  // ── unsupported (FilesApi does not model these) ───────────────────
  getAllPaths(): string[] {
    // Walking the full tree would be O(n) per glob — keep glob expansion
    // out of the bash layer by returning empty; bash falls back to its
    // per-directory iteration paths.
    return [];
  }

  chmod(_path: string, _mode: number): Promise<void> {
    return Promise.reject(new ENOSYS("chmod"));
  }

  symlink(_target: string, _linkPath: string): Promise<void> {
    return Promise.reject(new ENOSYS("symlink"));
  }

  link(_existingPath: string, _newPath: string): Promise<void> {
    return Promise.reject(new ENOSYS("link"));
  }

  readlink(_path: string): Promise<string> {
    return Promise.reject(new ENOSYS("readlink"));
  }

  utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    return Promise.reject(new ENOSYS("utimes"));
  }
}

async function concatChunks(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of it) {
    parts.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
