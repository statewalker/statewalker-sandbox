// Wasmer's host-filesystem protocol (wasmer-js js/bindgen/src/host_filesystem.rs, used by the
// SDK's experimental `storageHost`), answered with a capability. The sandbox's /workspace is
// the capability's namespace: every file operation the guest makes (stat, readDir, open, read,
// write, …) is a capability call, authorized per entry by the owner. Agent side: this runs in
// the Agent cell, not in the engine.
//
// Paths arrive relative to the mount ("" is its root, "proj/a.md" is the capability's
// /proj/a.md). Errors carry the POSIX code the protocol maps (ENOENT, EEXIST, EACCES, ENOTDIR,
// EISDIR, ENOTEMPTY, ENOTSUP).

import type { Cap } from "../caps.ts";
import { type DirEntryStat, MAX_WHOLE_FILE_BYTES } from "../sql-fs.ts";

export type HostFsReply = { value: unknown } | { error: { code: string; message: string } };

interface PlainStat {
  isDirectory: boolean;
  size: number;
  mtime: string;
}

/** A file some handle has open: one buffer per path, shared by its handles. */
interface OpenFile {
  path: string;
  /** Capacity grows by doubling; `size` is the file's length. */
  bytes: Uint8Array | undefined;
  size: number;
  loading?: Promise<void>;
  dirty: boolean;
  refs: number;
  /** Whether the capability lets this file be written, asked at the first write. */
  writable?: Promise<void>;
  /**
   * Until the file is written (and `bytes` loaded), reads go through a chunk stream: only the
   * current chunk is held, so a file of any size reads in a constant amount of memory.
   */
  reader?: Reader;
  /** Reads of one file, one at a time (the stream has one position). */
  reading?: Promise<unknown>;
}

interface Reader {
  id: string;
  /** The file's size when the stream was opened (what it reads). */
  size: number;
  /** Where the stream continues, and the chunk last read (bytes from `chunkAt`). */
  pos: number;
  chunk: Uint8Array;
  chunkAt: number;
}

interface Handle {
  file: OpenFile;
  append: boolean;
}

const encoder = new TextEncoder();
/** At most this many open files per sandbox; at most this many bytes per file in memory. */
const MAX_HANDLES = 256;
/** What all open files of a sandbox may hold in memory together. */
const MAX_OPEN_BYTES = 64 * 1024 * 1024;
/** Bytes per chunk of a read stream (one store block). */
const STREAM_CHUNK = 1024 * 1024;
const EMPTY_BYTES = new Uint8Array();
/** What the store takes whole: a larger file would only fail at close, which WASIX does not report. */
const MAX_FILE_BYTES = MAX_WHOLE_FILE_BYTES;
/**
 * Metadata (stat, "no such file", listings) is cached per sandbox for one command at most:
 * the kernel clears it before each command, so a write made between commands (a Flue tool, an
 * other agent) is seen by the next one. Within a command, entries live this long, and this
 * run's own writes forget what they change. Other writers' changes during a command (a Flue
 * tool call running in parallel, another agent), and a revocation, may be seen this late in
 * names and sizes; contents are read and written through the capability every time, and an
 * open that may create a file always asks it (a cached "no such file" must not truncate one).
 */
const META_TTL_MS = 2000;
/** Stats plus listed entries held; past it, the cache starts over. */
const MAX_META_ENTRIES = 20_000;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const nanos = (iso: string) => String(BigInt(Date.parse(iso) || 0) * 1_000_000n);
const asBytes = (v: unknown) =>
  v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer | ArrayLike<number>);

/** A protocol handler for one sandbox, over `cap`. */
export function capHostFs(cap: Cap) {
  const abs = (rel: unknown) => {
    const p = String(rel ?? "")
      .split("/")
      .filter((s) => s && s !== ".");
    if (p.includes("..")) throw err("EACCES", "'..' is not a path segment here");
    return `/${p.join("/")}`;
  };
  const handles = new Map<number, Handle>();
  const files = new Map<string, OpenFile>();
  let next = 1;

  // ---- metadata cache (see META_TTL_MS) ----
  /** A path's stat, or null: no such file. Refusals (EACCES) are not cached. */
  const meta = new Map<string, { at: number; stat: PlainStat | null }>();
  const listings = new Map<string, { at: number; entries: DirEntryStat[] }>();
  let listed = 0;
  /**
   * Bumped by every forget and reset: an answer that arrives after one (a call the kernel gave
   * up on, a write made meanwhile) is used but not cached.
   */
  let epoch = 0;
  const clear = () => {
    meta.clear();
    listings.clear();
    listed = 0;
    epoch++;
  };
  const fresh = (e: { at: number } | undefined) => !!e && Date.now() - e.at < META_TTL_MS;
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const childOf = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
  const remember = (path: string, stat: PlainStat | null) => {
    if (meta.size + listed >= MAX_META_ENTRIES) clear();
    meta.set(path, { at: Date.now(), stat });
  };
  const unlist = (dir: string) => {
    const old = listings.get(dir);
    if (!old) return;
    listed -= old.entries.length;
    listings.delete(dir);
  };
  /** What this run changed at `path` (and under it, for a directory) is forgotten. */
  const forget = (path: string, tree = false) => {
    epoch++;
    meta.delete(path);
    unlist(path);
    unlist(parentOf(path));
    if (!tree) return;
    const under = `${path}/`;
    for (const k of meta.keys()) if (k.startsWith(under)) meta.delete(k);
    for (const k of listings.keys()) if (k.startsWith(under)) unlist(k);
  };
  const plainStat = async (path: string): Promise<PlainStat | null> => {
    const cached = meta.get(path);
    if (fresh(cached)) return (cached as { stat: PlainStat | null }).stat;
    const at = epoch;
    try {
      const s = (await cap.call("stat", path)) as PlainStat;
      if (at === epoch) remember(path, s);
      return s;
    } catch (e) {
      if ((e as { code?: string })?.code !== "ENOENT") throw e;
      if (at === epoch) remember(path, null);
      return null;
    }
  };
  const exists = async (path: string) => (await plainStat(path)) !== null;
  const listing = async (dir: string): Promise<DirEntryStat[]> => {
    const cached = listings.get(dir);
    if (fresh(cached)) return (cached as { entries: DirEntryStat[] }).entries;
    const at = epoch;
    const entries = (await cap.call("readdirStat", dir)) as DirEntryStat[];
    if (at !== epoch) return entries;
    if (meta.size + listed + entries.length >= MAX_META_ENTRIES) clear();
    const old = listings.get(dir);
    if (old) listed -= old.entries.length;
    listings.set(dir, { at: Date.now(), entries });
    listed += entries.length;
    // A listing answers the stat of each entry it shows (what it hides is asked as before).
    for (const e of entries) remember(childOf(dir, e.name), e as unknown as PlainStat);
    return entries;
  };

  const stat = async (path: string) => {
    const s = await plainStat(path);
    if (!s) throw err("ENOENT", `${path}: no such file or directory`);
    const t = nanos(s.mtime);
    return {
      kind: s.isDirectory ? "directory" : "file",
      size: s.size,
      modified: t,
      accessed: t,
      created: t,
    };
  };
  const handle = (id: unknown) => {
    const h = handles.get(Number(id));
    if (!h) throw err("EBADF", `no open file ${String(id)}`);
    return h;
  };
  /** The file's bytes, read once per open file (concurrent callers share the read). */
  const load = async (f: OpenFile) => {
    if (!f.bytes) {
      f.loading ??= (async () => {
        const bytes = (await exists(f.path))
          ? asBytes(await cap.call("readFileBuffer", f.path))
          : new Uint8Array();
        if (bytes.length > MAX_FILE_BYTES)
          throw err("EFBIG", `${f.path}: files are at most ${MAX_FILE_BYTES} bytes here`);
        if (held() + bytes.length > MAX_OPEN_BYTES)
          throw err("ENOMEM", `open files hold at most ${MAX_OPEN_BYTES} bytes together`);
        if (!f.bytes) {
          f.bytes = bytes;
          f.size = bytes.length;
          closeReader(f); // the loaded bytes are read from now on
        }
      })().finally(() => {
        f.loading = undefined;
      });
      await f.loading;
    }
    return f.bytes as Uint8Array;
  };
  const save = async (f: OpenFile) => {
    if (!f.dirty || !f.bytes) return;
    f.dirty = false;
    try {
      // The bytes as they are: the store keeps binary content byte for byte.
      await cap.call("writeFileBuffer", f.path, f.bytes.slice(0, f.size));
      forget(f.path);
    } catch (e) {
      f.dirty = true;
      throw e;
    }
  };
  /**
   * Writes are saved at flush or close, whose errors WASIX drops: a write the capability refuses
   * fails at the first write instead (an empty append asks for the right without changing text).
   */
  const mayWrite = (f: OpenFile) => {
    f.writable ??= cap.call("appendFile", f.path, "").then(() => forget(f.path));
    f.writable.catch(() => (f.writable = undefined));
    return f.writable;
  };
  const held = () => {
    let n = 0;
    for (const f of files.values()) n += f.bytes?.length ?? 0;
    return n;
  };
  /** Room for `length` bytes, growing the capacity by doubling. */
  const reserve = (f: OpenFile, length: number) => {
    if (length > MAX_FILE_BYTES)
      throw err("EFBIG", `${f.path}: files are at most ${MAX_FILE_BYTES} bytes here`);
    const b = f.bytes as Uint8Array;
    if (length <= b.length) return b;
    const capacity = Math.min(MAX_FILE_BYTES, Math.max(length, b.length * 2, 4096));
    if (held() - b.length + capacity > MAX_OPEN_BYTES)
      throw err("ENOMEM", `open files hold at most ${MAX_OPEN_BYTES} bytes together`);
    const out = new Uint8Array(capacity);
    out.set(b.subarray(0, f.size));
    f.bytes = out;
    return out;
  };
  const closeReader = (f: OpenFile) => {
    const r = f.reader;
    f.reader = undefined;
    if (r) cap.call("closeRead", f.path, r.id).catch(() => {});
  };
  const openReader = async (f: OpenFile, at: number): Promise<Reader | undefined> => {
    closeReader(f);
    try {
      const { id, size } = (await cap.call("openRead", f.path, { start: at })) as {
        id: string;
        size: number;
      };
      f.reader = { id, size, pos: Math.min(at, size), chunk: EMPTY_BYTES, chunkAt: at };
      return f.reader;
    } catch (e) {
      const code =
        (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(String((e as Error)?.message))?.[1];
      // No room for one more stream: read the file whole, as before streams.
      if (code === "EMFILE") return undefined;
      throw e;
    }
  };
  /** `length` bytes at `offset` through the file's stream (reopened where a read jumps). */
  const streamRead = async (f: OpenFile, offset: number, length: number): Promise<Uint8Array> => {
    let r = f.reader;
    if (r && offset >= r.size) return EMPTY_BYTES; // past the end: nothing to reopen for
    const inChunk = (at: number) => !!r && at >= r.chunkAt && at < r.chunkAt + r.chunk.length;
    if (!r || (!inChunk(offset) && offset !== r.pos)) r = await openReader(f, offset);
    if (!r) {
      const b = await load(f);
      return b.slice(Math.min(offset, f.size), Math.min(f.size, offset + length));
    }
    const end = Math.min(offset + length, r.size);
    const parts: Uint8Array[] = [];
    let at = offset;
    while (at < end) {
      if (!inChunk(at)) {
        if (at !== r.pos) break;
        const chunk = asBytes(await cap.call("readChunk", f.path, r.id, STREAM_CHUNK));
        if (!chunk.length) break;
        r.chunk = chunk;
        r.chunkAt = r.pos;
        r.pos += chunk.length;
      }
      const from = at - r.chunkAt;
      const take = r.chunk.subarray(from, Math.min(r.chunk.length, from + (end - at)));
      parts.push(take);
      at += take.length;
    }
    if (parts.length === 1) return parts[0].slice();
    const out = new Uint8Array(at - offset);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const release = async (id: number) => {
    const h = handles.get(id);
    if (!h) return;
    handles.delete(id);
    if (--h.file.refs === 0) {
      files.delete(h.file.path);
      closeReader(h.file);
    }
    await save(h.file);
  };

  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    stat: (p) => stat(abs(p)),
    async readDir(p) {
      // One capability call for the whole listing (entries the token may not list are left out).
      const entries = await listing(abs(p));
      return entries.map((e) => {
        const t = nanos(e.mtime);
        return {
          name: e.name,
          kind: e.isDirectory ? "directory" : "file",
          size: e.size,
          modified: t,
          accessed: t,
          created: t,
        };
      });
    },
    async open(p, _read, write, create, createNew, truncate, append) {
      const path = abs(p);
      if (handles.size >= MAX_HANDLES) throw err("EMFILE", "too many open files");
      // An open that may create the file asks the capability, not the cache: a "no such file"
      // seen earlier must not truncate a file a parallel writer has made since.
      if (write && create) forget(path);
      const found = await plainStat(path);
      const exists = found !== null;
      if (createNew && exists) throw err("EEXIST", `${path} exists`);
      if (!exists && !create) throw err("ENOENT", `${path}: no such file`);
      if (found?.isDirectory) throw err("EISDIR", `${path} is a directory`);
      // A refused create or truncate fails here. WASIX opens files for writing even to read
      // them, so writing an existing file is checked at the first write instead.
      if (write && (!exists || truncate)) {
        await cap.call("writeFile", path, "");
        forget(path);
      }
      let f = files.get(path);
      if (!f) {
        f = { path, bytes: undefined, size: 0, dirty: false, refs: 0 };
        files.set(path, f);
      }
      if (write && (!exists || truncate)) {
        f.bytes = new Uint8Array();
        f.size = 0;
        f.dirty = false;
        f.writable = Promise.resolve();
      }
      f.refs++;
      const id = next++;
      handles.set(id, { file: f, append: !!append });
      return id;
    },
    async read(id, offset, length) {
      const f = handle(id).file;
      const run = async () => {
        if (!f.bytes) return streamRead(f, Number(offset), Number(length));
        const at = Math.min(Number(offset), f.size);
        return f.bytes.slice(at, Math.min(f.size, at + Number(length)));
      };
      const p = (f.reading ?? Promise.resolve()).then(run, run);
      f.reading = p.catch(() => {});
      return p;
    },
    async write(id, offset, bytes) {
      const h = handle(id);
      const f = h.file;
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[]);
      await mayWrite(f);
      await load(f);
      const at = h.append ? f.size : Number(offset);
      const end = at + data.length;
      const b = reserve(f, Math.max(f.size, end));
      if (at > f.size) b.fill(0, f.size, at);
      b.set(data, at);
      f.size = Math.max(f.size, end);
      f.dirty = true;
      return data.length;
    },
    async setLen(id, length) {
      const f = handle(id).file;
      await mayWrite(f);
      await load(f);
      const n = Number(length);
      const b = reserve(f, n);
      if (n > f.size) b.fill(0, f.size, n);
      f.size = n;
      f.dirty = true;
      return null;
    },
    async fileStat(id) {
      const f = handle(id).file;
      const s = (await exists(f.path))
        ? await stat(f.path)
        : { kind: "file", size: 0, modified: "0", accessed: "0", created: "0" };
      return { ...s, size: f.bytes ? f.size : s.size };
    },
    async flush(id) {
      await save(handle(id).file);
      return null;
    },
    async close(id) {
      await release(Number(id));
      return null;
    },
    async mkdir(p) {
      const path = abs(p);
      try {
        await cap.call("mkdir", path);
      } finally {
        forget(path);
      }
      return null;
    },
    async remove(p) {
      const path = abs(p);
      // The store removes a directory only recursively: an empty one is removed that way.
      const s = (await cap.call("stat", path)) as PlainStat;
      try {
        if (s.isDirectory) {
          if ((await cap.readdir(path)).length) throw err("ENOTEMPTY", `${path} is not empty`);
          await cap.call("rm", path, { recursive: true });
        } else await cap.call("rm", path);
      } finally {
        forget(path, true);
      }
      const f = files.get(path);
      if (f) f.dirty = false;
      return null;
    },
    async rename(from, to) {
      const src = abs(from);
      const dst = abs(to);
      const f = files.get(src);
      if (f) await save(f);
      try {
        await cap.move("mv", src, dst);
      } finally {
        forget(src, true);
        forget(dst, true);
      }
      if (f) {
        files.delete(src);
        f.path = dst;
        f.writable = undefined;
        files.set(dst, f);
      }
      return null;
    },
    // Times are the store's own (it records the write time); symlinks do not exist.
    setTimes: async () => null,
    setFileTimes: async () => null,
    sync: async () => null,
  };

  return {
    async handle(method: string, args: unknown[]): Promise<HostFsReply> {
      const op = Object.hasOwn(ops, method) ? ops[method] : undefined;
      if (!op) return { error: { code: "ENOTSUP", message: `unsupported operation ${method}` } };
      try {
        return { value: await op(...(Array.isArray(args) ? args : [])) };
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        const code = (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(message)?.[1] ?? "EIO";
        return { error: { code, message } };
      }
    },
    /** Before each command: what others changed since the last one is seen (see META_TTL_MS). */
    resetCache() {
      clear();
    },
    /** Open files of a sandbox that ends are dropped: what was not flushed is not written. */
    close() {
      for (const f of files.values()) closeReader(f);
      handles.clear();
      files.clear();
      clear();
    },
  };
}

/** The reply buffer's header: [status (1 JSON, 2 bytes), length], then the reply. */
const HEADER_BYTES = 8;

/**
 * Answers a request of the SDK's worker bridge in place (browser engines share memory with the
 * Agent cell): writes the reply into the request's SharedArrayBuffer and wakes the waiting
 * thread. The format is the SDK's (`respondToHostFileSystem`).
 */
export function respondInPlace(
  request: { response: SharedArrayBuffer; binary?: boolean },
  reply: HostFsReply,
) {
  const control = new Int32Array(request.response, 0, 2);
  const value = "value" in reply ? reply.value : undefined;
  let binary = request.binary === true && value instanceof Uint8Array;
  let bytes = binary
    ? (value as Uint8Array)
    : encoder.encode(
        JSON.stringify(value instanceof Uint8Array ? { value: Array.from(value) } : reply),
      );
  if (bytes.length > request.response.byteLength - HEADER_BYTES) {
    binary = false;
    bytes = encoder.encode(
      JSON.stringify({ error: { code: "EIO", message: "reply exceeds the bridge's buffer" } }),
    );
  }
  new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
  control[1] = bytes.length;
  Atomics.store(control, 0, binary ? 2 : 1);
  Atomics.notify(control, 0);
}

/** Binary values travel over the Node engine's pipes as { $b64 }. */
export function encodeWire(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = "";
    for (let i = 0; i < v.length; i += 0x8000)
      s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { $b64: btoa(s) };
  }
  if (Array.isArray(v)) return v.map(encodeWire);
  return v;
}
export function decodeWire(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string")
    return Uint8Array.from(atob((v as { $b64: string }).$b64), (c) => c.charCodeAt(0));
  if (Array.isArray(v)) return v.map(decodeWire);
  return v;
}
