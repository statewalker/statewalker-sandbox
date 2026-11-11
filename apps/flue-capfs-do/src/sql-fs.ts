// The real store: a small file system on the owner Durable Object's own SQLite
// (`ctx.storage.sql`). It is durable (survives eviction and restarts), it never leaves the
// owner cell, and it is the only thing that touches file data. It knows nothing about
// rights: FsGate authorizes every entry an operation touches before calling it.
//
// Paths given to it are already normalised by the caller. A file's content is bytes, kept as
// BLOB blocks of at most BLOCK_BYTES (`fs_blocks`; each row under the Durable Object row limit),
// under an immutable content id the entry points at: a rename or a copy shares it, an overwrite
// writes a new one and drops the old once nothing (no entry, no open reader) refers to it.
// Text is stored as its UTF-8 bytes (writeFile, appendFile), binary content as is
// (writeFileBuffer, appendFileBuffer); readFileBuffer returns the bytes, readFile decodes them.
// Whole-file calls move at most MAX_WHOLE_FILE_BYTES; larger files are streamed in chunks
// (openRead/readChunk, openWrite/writeChunk/commitWrite), up to MAX_FILE_BYTES. Rows from
// before blocks keep their content in `fs_entries.data` and are read from there.

import { asBytes } from "./bytes.ts";
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
   * Content kept in the row itself, from before blocks: read as `CAST(data AS BLOB)` so a TEXT
   * value comes back whole (node:sqlite cuts TEXT at a NUL). Null once the row has a content id.
   */
  data: ArrayBuffer | Uint8Array | null;
  /** The content id of the file's blocks (null: directories, and rows from before blocks). */
  content: number | null;
  size: number | null;
  mode: number;
  mtime: number;
};

type ReadStream = {
  kind: "read";
  path: string;
  owner: string;
  content: number | null;
  legacy?: Uint8Array;
  pos: number;
  end: number;
  at: number;
};
type WriteStream = {
  kind: "write";
  path: string;
  owner: string;
  content: number;
  /** The next block's index, and the bytes not yet making a whole block. */
  next: number;
  tail: Uint8Array;
  size: number;
  at: number;
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
/** One block of a file's content: one row, under the Durable Object row limit (2 MB). */
export const BLOCK_BYTES = 1024 * 1024;
/** What a whole-file call (readFile, writeFile, appendFile, …) moves in one message. */
export const MAX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;
/** A file, streamed in chunks. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** An open stream not used for this long is closed (an unfinished write is dropped). */
export const STREAM_IDLE_MS = 2 * 60_000;
/** Open streams per Workspace cell. */
const MAX_STREAMS = 256;
const EMPTY = new Uint8Array();
const concat = (a: Uint8Array, b: Uint8Array) => {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Bytes as they arrive over RPC: a Uint8Array, any ArrayBuffer view, or an ArrayBuffer. */
export function bytesArg(d: unknown): Uint8Array {
  const b = asBytes(d);
  if (!b) throw fsError("EINVAL", "binary content must be a Uint8Array or an ArrayBuffer");
  return b;
}
/** Bytes as the ArrayBuffer SQL bindings take (exactly the view's bytes). */
const toBlob = (b: Uint8Array): ArrayBuffer =>
  (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? b.buffer
    : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) as ArrayBuffer;

export class SqlFs {
  #sql: SqlLike;
  #streams = new Map<string, ReadStream | WriteStream>();
  /** Content ids open readers hold: not dropped while held. */
  #pins = new Map<number, number>();
  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS fs_entries (
      path TEXT PRIMARY KEY, parent TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT, mode INTEGER NOT NULL, mtime INTEGER NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS fs_entries_parent ON fs_entries(parent)");
    sql.exec("CREATE TABLE IF NOT EXISTS fs_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS fs_blocks (
      content INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB, PRIMARY KEY (content, idx))`);
    // Schema 2: content in blocks. A store from before gets the columns once (one already there,
    // from a run that stopped before the row was written, is skipped).
    const schema = Number(
      sql.exec("SELECT value FROM fs_meta WHERE key = 'schema'").toArray()[0]?.value ?? 1,
    );
    if (schema < 2) {
      for (const col of ["content INTEGER", "size INTEGER"]) {
        try {
          sql.exec(`ALTER TABLE fs_entries ADD COLUMN ${col}`);
        } catch (e) {
          if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
        }
      }
      sql.exec("INSERT OR REPLACE INTO fs_meta (key, value) VALUES ('schema', '2')");
    }
    sql.exec("CREATE INDEX IF NOT EXISTS fs_entries_content ON fs_entries(content)");
    // Blocks no entry refers to: writes that were never committed before the cell restarted.
    sql.exec(
      "DELETE FROM fs_blocks WHERE content NOT IN (SELECT content FROM fs_entries WHERE content IS NOT NULL)",
    );
  }

  #get(path: string): Row | undefined {
    if (path === "/")
      return {
        id: 0,
        path: "/",
        kind: "dir",
        data: null,
        content: null,
        size: null,
        mode: 0o755,
        mtime: 0,
      };
    return this.#sql
      .exec(
        `SELECT rowid AS id, path, kind, CASE WHEN content IS NULL THEN CAST(data AS BLOB) END AS data,
           content, size, mode, mtime FROM fs_entries WHERE path = ?`,
        path,
      )
      .toArray()[0] as Row | undefined;
  }

  // ---- content: blocks under an immutable content id ----

  #newContent(): number {
    const next =
      Number(
        this.#sql.exec("SELECT value FROM fs_meta WHERE key = 'next_content'").toArray()[0]
          ?.value ?? 0,
      ) + 1;
    this.#sql.exec(
      "INSERT OR REPLACE INTO fs_meta (key, value) VALUES ('next_content', ?)",
      String(next),
    );
    return next;
  }
  #putBlock(content: number, idx: number, bytes: Uint8Array) {
    this.#sql.exec(
      "INSERT OR REPLACE INTO fs_blocks (content, idx, data) VALUES (?, ?, ?)",
      content,
      idx,
      toBlob(bytes),
    );
  }
  /** Writes `bytes` as blocks from index `from`; returns the next index. */
  #putBlocks(content: number, bytes: Uint8Array, from = 0): number {
    let idx = from;
    for (let at = 0; at < bytes.length; at += BLOCK_BYTES)
      this.#putBlock(content, idx++, bytes.subarray(at, at + BLOCK_BYTES));
    return idx;
  }
  /** Bytes [start, end) of a content id's blocks. */
  #readBlocks(content: number, start: number, end: number): Uint8Array {
    if (end <= start) return EMPTY;
    const first = Math.floor(start / BLOCK_BYTES);
    const last = Math.floor((end - 1) / BLOCK_BYTES);
    const rows = this.#sql
      .exec(
        "SELECT idx, data FROM fs_blocks WHERE content = ? AND idx BETWEEN ? AND ? ORDER BY idx",
        content,
        first,
        last,
      )
      .toArray();
    const out = new Uint8Array(end - start);
    for (const r of rows) {
      const b = bytesOf(r.data as Row["data"]);
      const blockStart = Number(r.idx) * BLOCK_BYTES;
      const from = Math.max(start, blockStart);
      const to = Math.min(end, blockStart + b.length);
      if (to > from) out.set(b.subarray(from - blockStart, to - blockStart), from - start);
    }
    return out;
  }
  #sizeOf(row: Row): number {
    return row.content !== null ? Number(row.size ?? 0) : bytesOf(row.data).length;
  }
  /** A file's whole content, for the whole-file calls. */
  #bytes(row: Row): Uint8Array {
    if (row.content === null) return bytesOf(row.data).slice();
    const size = this.#sizeOf(row);
    if (size > MAX_WHOLE_FILE_BYTES)
      throw fsError(
        "EFBIG",
        `file too large to read whole '${row.path}' (${size} bytes): read it as a stream`,
      );
    return this.#readBlocks(row.content, 0, size);
  }
  /** Drops a content id's blocks once no entry and no open reader refers to it. */
  #release(content: number | null) {
    if (content === null || this.#pins.get(content)) return;
    if (
      this.#sql.exec("SELECT 1 FROM fs_entries WHERE content = ? LIMIT 1", content).toArray().length
    )
      return;
    this.#sql.exec("DELETE FROM fs_blocks WHERE content = ?", content);
  }
  /** Points `path` at `content` (null for a directory), dropping what it pointed at before. */
  #setEntry(
    path: string,
    kind: "file" | "dir",
    content: number | null,
    size: number | null,
    mode?: number,
  ) {
    const old = this.#get(path)?.content ?? null;
    this.#sql.exec(
      `INSERT INTO fs_entries (path, parent, kind, data, content, size, mode, mtime) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, data = NULL, content = excluded.content,
         size = excluded.size, mtime = excluded.mtime`,
      path,
      dirname(path),
      kind,
      content,
      size,
      mode ?? (kind === "dir" ? 0o755 : 0o644),
      Date.now(),
    );
    if (old !== null && old !== content) this.#release(old);
  }
  /** A new content id holding a copy of `row`'s content, but for its last partial block. */
  #copyForAppend(row: Row | undefined): {
    content: number;
    next: number;
    tail: Uint8Array;
    size: number;
  } {
    const content = this.#newContent();
    if (!row || row.kind !== "file") return { content, next: 0, tail: EMPTY, size: 0 };
    const size = this.#sizeOf(row);
    if (row.content === null) {
      const b = bytesOf(row.data);
      const whole = b.length - (b.length % BLOCK_BYTES);
      const next = this.#putBlocks(content, b.subarray(0, whole));
      return { content, next, tail: b.slice(whole), size };
    }
    const full = Math.floor(size / BLOCK_BYTES);
    this.#sql.exec(
      "INSERT INTO fs_blocks (content, idx, data) SELECT ?, idx, data FROM fs_blocks WHERE content = ? AND idx < ?",
      content,
      row.content,
      full,
    );
    return {
      content,
      next: full,
      tail: this.#readBlocks(row.content, full * BLOCK_BYTES, size),
      size,
    };
  }
  #must(path: string): Row {
    const row = this.#get(path);
    if (!row) throw fsError("ENOENT", `no such file or directory '${path}'`);
    return row;
  }
  /** A directory, or a file with `bytes` (written as a new content id). */
  #put(path: string, kind: "file" | "dir", bytes: Uint8Array | null, mode?: number) {
    if (kind === "dir") return this.#setEntry(path, "dir", null, null, mode);
    const b = bytes ?? EMPTY;
    if (b.length > MAX_WHOLE_FILE_BYTES)
      throw fsError(
        "EFBIG",
        `file too large to write whole '${path}' (${b.length} bytes): write it as a stream`,
      );
    const content = this.#newContent();
    this.#putBlocks(content, b);
    this.#setEntry(path, "file", content, b.length, mode);
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
    return dec.decode(this.#bytes(row));
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const row = this.#must(path);
    if (row.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, read '${path}'`);
    return this.#bytes(row);
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
  /** Appends without reading the file whole: its full blocks are shared into a new content id. */
  #append(path: string, more: Uint8Array) {
    const row = this.#get(path);
    if (row?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, append '${path}'`);
    if (more.length > MAX_WHOLE_FILE_BYTES)
      throw fsError("EFBIG", `too much to append whole '${path}': write it as a stream`);
    this.#ensureParents(path);
    const c = this.#copyForAppend(row);
    const size = c.size + more.length;
    if (size > MAX_FILE_BYTES) {
      this.#release(c.content);
      throw fsError("EFBIG", `file too large '${path}': at most ${MAX_FILE_BYTES} bytes`);
    }
    this.#putBlocks(c.content, concat(c.tail, more), c.next);
    this.#setEntry(path, "file", c.content, size);
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
      size: row.kind === "file" ? this.#sizeOf(row) : 0,
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
        `SELECT path, kind, mtime, CASE WHEN kind = 'file'
           THEN coalesce(size, length(CAST(coalesce(data, '') AS BLOB))) ELSE 0 END AS size
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
      const contents = this.#sql
        .exec(
          `SELECT DISTINCT content FROM fs_entries WHERE ${SUBTREE} AND content IS NOT NULL`,
          ...subtreeArgs(path),
        )
        .toArray()
        .map((r) => Number(r.content));
      this.#sql.exec(`DELETE FROM fs_entries WHERE ${SUBTREE}`, ...subtreeArgs(path));
      for (const c of contents) this.#release(c);
    } else {
      this.#sql.exec("DELETE FROM fs_entries WHERE path = ?", path);
      this.#release(row.content);
    }
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
        // Content is immutable: a copy shares it (a row from before blocks is copied as bytes).
        const from = this.#get(e.path) as Row;
        if (from.content !== null) this.#setEntry(target, "file", from.content, from.size);
        else this.#put(target, "file", bytesOf(from.data));
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

  // ---- streams: content in chunks, for files of any size ----
  //
  // A stream is identified by a random id and bound to its owner (the capability that opened
  // it) and its path: chunk calls must name both. Reads see the content as it was when opened
  // (its blocks are held until closed). Writes go to a new content id, which becomes the file's
  // only at commit; until then nobody sees it, and an aborted, expired or never-committed write
  // leaves nothing behind.

  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.#streams) if (now - s.at > STREAM_IDLE_MS) this.#drop(id, s);
  }
  #drop(id: string, s: ReadStream | WriteStream) {
    this.#streams.delete(id);
    if (s.kind === "read") this.#unpin(s.content);
    else this.#release(s.content);
  }
  #pin(content: number | null) {
    if (content !== null) this.#pins.set(content, (this.#pins.get(content) ?? 0) + 1);
  }
  #unpin(content: number | null) {
    if (content === null) return;
    const n = (this.#pins.get(content) ?? 1) - 1;
    if (n > 0) this.#pins.set(content, n);
    else {
      this.#pins.delete(content);
      this.#release(content);
    }
  }
  #open(s: ReadStream | WriteStream): string {
    this.#sweep();
    if (this.#streams.size >= MAX_STREAMS) throw fsError("EMFILE", "too many open streams");
    const id = crypto.randomUUID();
    this.#streams.set(id, s);
    return id;
  }
  #stream<K extends "read" | "write">(
    kind: K,
    id: unknown,
    owner: string,
    path: string,
  ): K extends "read" ? ReadStream : WriteStream {
    this.#sweep();
    const s = this.#streams.get(String(id));
    if (!s || s.kind !== kind || s.owner !== owner || s.path !== path)
      throw fsError("EBADF", `no open ${kind} stream '${String(id)}' for '${path}'`);
    s.at = Date.now();
    return s as K extends "read" ? ReadStream : WriteStream;
  }

  /** Opens `path` for reading bytes [start, start + length). Returns the id and the file's size. */
  async openRead(
    path: string,
    opts: { start?: number; length?: number } | undefined,
    owner: string,
  ): Promise<{ id: string; size: number }> {
    const row = this.#must(path);
    if (row.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, read '${path}'`);
    const size = this.#sizeOf(row);
    const start = Math.min(Math.max(0, Math.floor(Number(opts?.start) || 0)), size);
    const length = opts?.length === undefined ? size : Math.max(0, Math.floor(Number(opts.length)));
    const end = Math.min(size, start + length);
    this.#pin(row.content);
    const id = this.#open({
      kind: "read",
      path,
      owner,
      content: row.content,
      legacy: row.content === null ? bytesOf(row.data).slice() : undefined,
      pos: start,
      end,
      at: Date.now(),
    });
    return { id, size };
  }
  /** The next chunk (at most `max` bytes, at most one block); an empty chunk at the end. */
  async readChunk(path: string, id: unknown, max: unknown, owner: string): Promise<Uint8Array> {
    const s = this.#stream("read", id, owner, path);
    const n = Math.min(
      Math.max(1, Math.floor(Number(max) || BLOCK_BYTES)),
      BLOCK_BYTES,
      s.end - s.pos,
    );
    if (n <= 0) return EMPTY;
    const out =
      s.content !== null
        ? this.#readBlocks(s.content, s.pos, s.pos + n)
        : (s.legacy as Uint8Array).slice(s.pos, s.pos + n);
    s.pos += n;
    return out;
  }
  async closeRead(path: string, id: unknown, owner: string): Promise<void> {
    const s = this.#stream("read", id, owner, path);
    this.#drop(String(id), s);
  }

  /** Opens `path` for writing (replacing it, or `append`ing to it); nothing shows until commit. */
  async openWrite(
    path: string,
    opts: { append?: boolean } | undefined,
    owner: string,
  ): Promise<{ id: string }> {
    const row = this.#get(path);
    if (row?.kind === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, write '${path}'`);
    const c = opts?.append
      ? this.#copyForAppend(row)
      : { content: this.#newContent(), next: 0, tail: EMPTY, size: 0 };
    const id = this.#open({ kind: "write", path, owner, ...c, at: Date.now() });
    return { id };
  }
  async writeChunk(
    path: string,
    id: unknown,
    data: unknown,
    owner: string,
  ): Promise<{ size: number }> {
    const s = this.#stream("write", id, owner, path);
    const b = bytesArg(data);
    if (s.size + b.length > MAX_FILE_BYTES) {
      this.#drop(String(id), s);
      throw fsError("EFBIG", `file too large '${path}': at most ${MAX_FILE_BYTES} bytes`);
    }
    let tail = concat(s.tail, b.slice());
    while (tail.length >= BLOCK_BYTES) {
      this.#putBlock(s.content, s.next++, tail.subarray(0, BLOCK_BYTES));
      tail = tail.slice(BLOCK_BYTES);
    }
    s.tail = tail;
    s.size += b.length;
    return { size: s.size };
  }
  /** Makes what was written the file's content, at once. */
  async commitWrite(path: string, id: unknown, owner: string): Promise<{ size: number }> {
    const s = this.#stream("write", id, owner, path);
    this.#streams.delete(String(id));
    try {
      if (s.tail.length) this.#putBlock(s.content, s.next++, s.tail);
      if (this.#get(path)?.kind === "dir")
        throw fsError("EISDIR", `illegal operation on a directory, write '${path}'`);
      this.#ensureParents(path);
      this.#setEntry(path, "file", s.content, s.size);
      return { size: s.size };
    } catch (e) {
      this.#release(s.content);
      throw e;
    }
  }
  async abortWrite(path: string, id: unknown, owner: string): Promise<void> {
    const s = this.#stream("write", id, owner, path);
    this.#drop(String(id), s);
  }
}
