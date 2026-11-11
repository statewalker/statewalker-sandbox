// The real store: a small file system on the owner Durable Object's own SQLite
// (`ctx.storage.sql`). It is durable (survives eviction and restarts), it never leaves the
// owner cell, and it is the only thing that touches file data. It knows nothing about
// rights: FsGate authorizes every entry an operation touches before calling it.
//
// Paths given to it are already normalised by the caller. A file's content is a BLOB of bytes:
// text is stored as its UTF-8 bytes (writeFile, appendFile; a TEXT value would end at the
// first NUL on node:sqlite), binary content as is (writeFileBuffer, appendFileBuffer).
// readFileBuffer returns the bytes; readFile decodes them as UTF-8 (invalid sequences of a
// binary file read as U+FFFD there).

import { dirname, fsError, join } from "./path.ts";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface PlainStat {
  /** Stable per path while it exists (the row id): just-bash compares (dev, ino) for "same file". */
  ino: number;
  dev: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: string;
}

export interface DirEntryStat {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
}

export interface Entry {
  path: string;
  kind: "file" | "dir";
}

type Row = {
  id: number;
  path: string;
  kind: "file" | "dir";
  /**
   * The file's UTF-8 bytes, read as `CAST(data AS BLOB)` so rows written as TEXT before BLOBs
   * come back whole too (node:sqlite cuts TEXT at a NUL). ArrayBuffer on workerd and cellb;
   * NULL for directories and for empty files (an empty buffer binds as NULL).
   */
  data: ArrayBuffer | Uint8Array | null;
  mode: number;
  mtime: number;
};

// Subtree queries compare bytes (case-sensitive), never LIKE: SQLite's LIKE ignores ASCII
// case, so `/HR/%` would also match `/hr/…`.
const SUBTREE = "(path = ? OR substr(path, 1, ?) = ?)";
const subtreeArgs = (path: string) => [path, path.length + 1, `${path}/`];

const enc = new TextEncoder();
// A leading U+FEFF is part of the text, not a marker to drop.
const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const bytesOf = (data: Row["data"]): Uint8Array =>
  data == null ? new Uint8Array() : data instanceof Uint8Array ? data : new Uint8Array(data);
/** Bytes as the ArrayBuffer SQL bindings take (exactly the view's bytes). */
/** Bytes as they arrive over RPC: a Uint8Array, any ArrayBuffer view, or an ArrayBuffer. */
export function bytesArg(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  throw fsError("EINVAL", "binary content must be a Uint8Array or an ArrayBuffer");
}
const toBlob = (b: Uint8Array): ArrayBuffer =>
  (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? b.buffer
    : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) as ArrayBuffer;

export class SqlFs {
  #sql: SqlLike;
  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS fs_entries (
      path TEXT PRIMARY KEY, parent TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT, mode INTEGER NOT NULL, mtime INTEGER NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS fs_entries_parent ON fs_entries(parent)");
  }

  #get(path: string): Row | undefined {
    if (path === "/") return { id: 0, path: "/", kind: "dir", data: null, mode: 0o755, mtime: 0 };
    return this.#sql
      .exec(
        "SELECT rowid AS id, path, kind, CAST(data AS BLOB) AS data, mode, mtime FROM fs_entries WHERE path = ?",
        path,
      )
      .toArray()[0] as Row | undefined;
  }
  #must(path: string): Row {
    const row = this.#get(path);
    if (!row) throw fsError("ENOENT", `no such file or directory '${path}'`);
    return row;
  }
  /** The column is declared TEXT; TEXT affinity never converts a BLOB, so the bytes stay. */
  #put(path: string, kind: "file" | "dir", bytes: Uint8Array | null, mode?: number) {
    this.#sql.exec(
      `INSERT INTO fs_entries (path, parent, kind, data, mode, mtime) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = excluded.data, mtime = excluded.mtime`,
      path,
      dirname(path),
      kind,
      bytes === null ? null : toBlob(bytes),
      mode ?? (kind === "dir" ? 0o755 : 0o644),
      Date.now(),
    );
  }
  #ensureParents(path: string) {
    const parent = dirname(path);
    if (parent === "/") return;
    const row = this.#get(parent);
    if (row?.kind === "file") throw fsError("ENOTDIR", `not a directory '${parent}'`);
    if (!row) {
      this.#ensureParents(parent);
      this.#put(parent, "dir", null);
    }
  }
  #children(path: string): string[] {
    return this.#sql
      .exec("SELECT path FROM fs_entries WHERE parent = ? ORDER BY path", path)
      .toArray()
      .map((r) => String(r.path).slice(path === "/" ? 1 : path.length + 1));
  }

  /** The ancestors of `path` that do not exist yet, outermost first (they would be created). */
  async missingParents(path: string): Promise<string[]> {
    const out: string[] = [];
    for (let p = dirname(path); p !== "/" && !this.#get(p); p = dirname(p)) out.unshift(p);
    return out;
  }

  async readFile(path: string): Promise<string> {
    const row = this.#must(path);
    if (row.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, read '${path}'`);
    return dec.decode(bytesOf(row.data));
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const row = this.#must(path);
    if (row.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, read '${path}'`);
    return bytesOf(row.data).slice();
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.#write(path, enc.encode(String(data ?? "")));
  }
  /** Binary content, stored byte for byte. */
  async writeFileBuffer(path: string, data: unknown): Promise<void> {
    this.#write(path, bytesArg(data));
  }
  async appendFile(path: string, data: string): Promise<void> {
    this.#append(path, enc.encode(String(data ?? "")));
  }
  async appendFileBuffer(path: string, data: unknown): Promise<void> {
    this.#append(path, bytesArg(data));
  }
  #write(path: string, bytes: Uint8Array) {
    if (this.#get(path)?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, write '${path}'`);
    this.#ensureParents(path);
    this.#put(path, "file", bytes);
  }
  #append(path: string, tail: Uint8Array) {
    const row = this.#get(path);
    if (row?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, append '${path}'`);
    this.#ensureParents(path);
    const head = bytesOf(row?.data ?? null);
    const out = new Uint8Array(head.length + tail.length);
    out.set(head);
    out.set(tail, head.length);
    this.#put(path, "file", out);
  }
  async exists(path: string): Promise<boolean> {
    return this.#get(path) !== undefined;
  }
  async stat(path: string): Promise<PlainStat> {
    const row = this.#must(path);
    return {
      ino: row.id + 1,
      dev: 1,
      isFile: row.kind === "file",
      isDirectory: row.kind === "dir",
      isSymbolicLink: false,
      size: row.kind === "file" ? bytesOf(row.data).length : 0,
      mode: row.mode,
      mtime: new Date(row.mtime).toISOString(),
    };
  }
  lstat(path: string): Promise<PlainStat> {
    return this.stat(path);
  }
  async realpath(path: string): Promise<string> {
    this.#must(path);
    return path;
  }
  async readdir(path: string): Promise<string[]> {
    const row = this.#must(path);
    if (row.kind !== "dir") throw fsError("ENOTDIR", `not a directory '${path}'`);
    return this.#children(path);
  }
  /** A directory's entries with what `stat` would say of each, in one query. */
  async readdirStat(path: string): Promise<DirEntryStat[]> {
    const row = this.#must(path);
    if (row.kind !== "dir") throw fsError("ENOTDIR", `not a directory '${path}'`);
    return this.#sql
      .exec(
        `SELECT path, kind, mtime, CASE WHEN kind = 'file' THEN length(CAST(coalesce(data, '') AS BLOB)) ELSE 0 END AS size
         FROM fs_entries WHERE parent = ? ORDER BY path`,
        path,
      )
      .toArray()
      .map((r) => ({
        name: String(r.path).slice(path === "/" ? 1 : path.length + 1),
        isDirectory: r.kind === "dir",
        size: Number(r.size),
        mtime: new Date(Number(r.mtime)).toISOString(),
      }));
  }
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const row = this.#get(path);
    if (row) {
      if (opts?.recursive && row.kind === "dir") return;
      throw fsError("EEXIST", `file already exists '${path}'`);
    }
    if (opts?.recursive) this.#ensureParents(path);
    else {
      const parent = this.#get(dirname(path));
      if (!parent) throw fsError("ENOENT", `no such file or directory '${dirname(path)}'`);
      if (parent.kind !== "dir") throw fsError("ENOTDIR", `not a directory '${dirname(path)}'`);
    }
    this.#put(path, "dir", null);
  }
  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (path === "/") throw fsError("EPERM", "cannot remove '/'");
    const row = this.#get(path);
    if (!row) {
      if (opts?.force) return;
      throw fsError("ENOENT", `no such file or directory '${path}'`);
    }
    if (row.kind === "dir") {
      if (this.#children(path).length > 0 && !opts?.recursive) {
        throw fsError("ENOTEMPTY", `directory not empty '${path}'`);
      }
      this.#sql.exec(`DELETE FROM fs_entries WHERE ${SUBTREE}`, ...subtreeArgs(path));
    } else this.#sql.exec("DELETE FROM fs_entries WHERE path = ?", path);
  }
  async chmod(path: string, mode: number): Promise<void> {
    this.#must(path);
    this.#sql.exec("UPDATE fs_entries SET mode = ? WHERE path = ?", Number(mode), path);
  }
  async utimes(path: string, _atime: unknown, mtime: unknown): Promise<void> {
    this.#must(path);
    const t =
      mtime instanceof Date
        ? mtime.getTime()
        : typeof mtime === "number"
          ? mtime * 1000
          : Date.now();
    this.#sql.exec("UPDATE fs_entries SET mtime = ? WHERE path = ?", t, path);
  }

  /** `path` and everything under it, parents before children. ENOENT if `path` does not exist. */
  async entries(path: string): Promise<Entry[]> {
    const row = this.#must(path);
    if (row.kind === "file") return [{ path, kind: "file" }];
    const rows = this.#sql
      .exec(
        `SELECT path, kind FROM fs_entries WHERE ${SUBTREE} ORDER BY path`,
        ...subtreeArgs(path),
      )
      .toArray() as unknown as Entry[];
    return path === "/" ? [{ path: "/", kind: "dir" }, ...rows] : rows;
  }

  /** `cp a dir` / `mv a dir` put `a` INTO an existing directory. Resolved once, at the top. */
  async resolveTarget(src: string, dst: string): Promise<string> {
    return this.#get(dst)?.kind === "dir" ? join(dst, src.slice(src.lastIndexOf("/") + 1)) : dst;
  }

  /** Copy `src` to exactly `dst` (already resolved). Refuses copying a tree into itself. */
  async cp(src: string, dst: string, opts?: { recursive?: boolean }): Promise<void> {
    if (src === "/") throw fsError("EINVAL", "cannot copy '/'");
    const list = await this.entries(src); // snapshot BEFORE the target exists
    if (list[0]?.kind === "dir" && !opts?.recursive)
      throw fsError("EISDIR", `'${src}' is a directory (not copied)`);
    if (dst === src || dst.startsWith(`${src}/`))
      throw fsError("EINVAL", `cannot copy '${src}' into itself`);
    for (const e of list) {
      const target = dst + e.path.slice(src.length);
      if (e.kind === "dir") await this.mkdir(target, { recursive: true });
      else {
        if (this.#get(target)?.kind === "dir")
          throw fsError("EISDIR", `illegal operation on a directory, write '${target}'`);
        this.#ensureParents(target);
        this.#put(target, "file", bytesOf(this.#get(e.path)?.data ?? null)); // the bytes, as they are
      }
    }
  }

  /** Move `src` to exactly `dst` (already resolved). Same path: no-op. Into itself: EINVAL. */
  async mv(src: string, dst: string): Promise<void> {
    if (src === "/") throw fsError("EINVAL", "cannot move '/'");
    this.#must(src);
    if (dst === src) return;
    if (dst.startsWith(`${src}/`)) throw fsError("EINVAL", `cannot move '${src}' into itself`);
    await this.cp(src, dst, { recursive: true });
    await this.rm(src, { recursive: true });
  }
}
