// The real store: a small file system on the owner Durable Object's own SQLite
// (`ctx.storage.sql`). It is durable (survives eviction and restarts), it never leaves the
// owner cell, and it is the only thing that touches file data. It knows nothing about
// rights: FilteredFiles authorizes every call before reaching it.
//
// Paths given to it are already normalised by the caller. Contents are stored as UTF-8 text.

import { dirname, fsError, join } from "./path.ts";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface PlainStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: string;
}

type Row = { path: string; kind: "file" | "dir"; data: string | null; mode: number; mtime: number };

const enc = new TextEncoder();

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
    if (path === "/") return { path: "/", kind: "dir", data: null, mode: 0o755, mtime: 0 };
    return this.#sql
      .exec("SELECT path, kind, data, mode, mtime FROM fs_entries WHERE path = ?", path)
      .toArray()[0] as Row | undefined;
  }
  #must(path: string): Row {
    const row = this.#get(path);
    if (!row) throw fsError("ENOENT", `no such file or directory '${path}'`);
    return row;
  }
  #put(path: string, kind: "file" | "dir", data: string | null, mode?: number) {
    this.#sql.exec(
      `INSERT INTO fs_entries (path, parent, kind, data, mode, mtime) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = excluded.data, mtime = excluded.mtime`,
      path,
      dirname(path),
      kind,
      data,
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

  async readFile(path: string): Promise<string> {
    const row = this.#must(path);
    if (row.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, read '${path}'`);
    return row.data ?? "";
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    return enc.encode(await this.readFile(path));
  }
  async writeFile(path: string, data: string): Promise<void> {
    if (this.#get(path)?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, write '${path}'`);
    this.#ensureParents(path);
    this.#put(path, "file", String(data ?? ""));
  }
  async appendFile(path: string, data: string): Promise<void> {
    const row = this.#get(path);
    if (row?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, append '${path}'`);
    this.#ensureParents(path);
    this.#put(path, "file", (row?.data ?? "") + String(data ?? ""));
  }
  async exists(path: string): Promise<boolean> {
    return this.#get(path) !== undefined;
  }
  async stat(path: string): Promise<PlainStat> {
    const row = this.#must(path);
    return {
      isFile: row.kind === "file",
      isDirectory: row.kind === "dir",
      isSymbolicLink: false,
      size: row.kind === "file" ? enc.encode(row.data ?? "").length : 0,
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
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const row = this.#get(path);
    if (row) {
      if (opts?.recursive && row.kind === "dir") return;
      throw fsError("EEXIST", `file already exists '${path}'`);
    }
    if (opts?.recursive) this.#ensureParents(path);
    else if (!this.#get(dirname(path)))
      throw fsError("ENOENT", `no such file or directory '${dirname(path)}'`);
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
      const hasChildren = this.#children(path).length > 0;
      if (hasChildren && !opts?.recursive)
        throw fsError("ENOTEMPTY", `directory not empty '${path}'`);
      this.#sql.exec(
        "DELETE FROM fs_entries WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        path,
        `${likeEscape(path)}/%`,
      );
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
  async cp(src: string, dst: string, opts?: { recursive?: boolean }): Promise<void> {
    const row = this.#must(src);
    if (row.kind === "file") return this.writeFile(this.#target(src, dst), row.data ?? "");
    if (!opts?.recursive) throw fsError("EISDIR", `'${src}' is a directory (not copied)`);
    const target = this.#target(src, dst);
    await this.mkdir(target, { recursive: true });
    for (const name of this.#children(src))
      await this.cp(join(src, name), join(target, name), opts);
  }
  async mv(src: string, dst: string): Promise<void> {
    const target = this.#target(src, dst);
    await this.cp(src, target, { recursive: true });
    await this.rm(src, { recursive: true });
  }
  // `cp a dir/` copies into dir.
  #target(src: string, dst: string): string {
    return this.#get(dst)?.kind === "dir" ? join(dst, src.slice(src.lastIndexOf("/") + 1)) : dst;
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
