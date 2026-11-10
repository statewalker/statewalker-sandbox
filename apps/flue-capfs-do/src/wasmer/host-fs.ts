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
}

interface Handle {
  file: OpenFile;
  append: boolean;
}

/** The store keeps UTF-8 text, so a file's bytes must decode. */
const encoder = new TextEncoder();
const strict = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** At most this many open files per sandbox; at most this many bytes per file in memory. */
const MAX_HANDLES = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const nanos = (iso: string) => String(BigInt(Date.parse(iso) || 0) * 1_000_000n);
const isContinuation = (b: number | undefined) => b !== undefined && (b & 0xc0) === 0x80;

/**
 * Refuses a write that makes the file something other than UTF-8 text, at the write itself
 * (WASIX drops the result of close, so a refusal at close would be silent). Only the bytes
 * around the written range are decoded; a character still incomplete at its end is allowed
 * (the next write may finish it) and is caught by the full check when the file is saved.
 */
function checkText(b: Uint8Array, from: number, to: number, path: string) {
  let start = from;
  for (let i = 0; i < 3 && isContinuation(b[start]); i++) start--;
  let end = to;
  for (let i = 0; i < 3 && isContinuation(b[end]); i++) end++;
  try {
    strict().decode(b.subarray(Math.max(0, start), end), { stream: true });
  } catch {
    throw err("ENOTSUP", `${path}: the store keeps UTF-8 text, not binary content`);
  }
}

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

  const stat = async (path: string) => {
    const s = (await cap.call("stat", path)) as PlainStat;
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
        const bytes = (await cap.call("exists", f.path))
          ? encoder.encode((await cap.call("readFile", f.path)) as string)
          : new Uint8Array();
        if (bytes.length > MAX_FILE_BYTES)
          throw err("EFBIG", `${f.path}: files are at most ${MAX_FILE_BYTES} bytes here`);
        if (!f.bytes) {
          f.bytes = bytes;
          f.size = bytes.length;
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
    let text: string;
    try {
      text = strict().decode(f.bytes.subarray(0, f.size));
    } catch {
      throw err("ENOTSUP", `${f.path}: the store keeps UTF-8 text, not binary content`);
    }
    f.dirty = false;
    try {
      await cap.call("writeFile", f.path, text);
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
    f.writable ??= cap.call("appendFile", f.path, "").then(() => {});
    f.writable.catch(() => (f.writable = undefined));
    return f.writable;
  };
  /** Room for `length` bytes, growing the capacity by doubling. */
  const reserve = (f: OpenFile, length: number) => {
    if (length > MAX_FILE_BYTES)
      throw err("EFBIG", `${f.path}: files are at most ${MAX_FILE_BYTES} bytes here`);
    const b = f.bytes as Uint8Array;
    if (length <= b.length) return b;
    const out = new Uint8Array(Math.min(MAX_FILE_BYTES, Math.max(length, b.length * 2, 4096)));
    out.set(b.subarray(0, f.size));
    f.bytes = out;
    return out;
  };
  const release = async (id: number) => {
    const h = handles.get(id);
    if (!h) return;
    handles.delete(id);
    if (--h.file.refs === 0) files.delete(h.file.path);
    await save(h.file);
  };

  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    stat: (p) => stat(abs(p)),
    async readDir(p) {
      const dir = abs(p);
      const names = await cap.readdir(dir);
      return Promise.all(
        names.map(async (name) => ({
          name,
          ...(await stat(dir === "/" ? `/${name}` : `${dir}/${name}`)),
        })),
      );
    },
    async open(p, _read, write, create, createNew, truncate, append) {
      const path = abs(p);
      if (handles.size >= MAX_HANDLES) throw err("EMFILE", "too many open files");
      const exists = (await cap.call("exists", path)) as boolean;
      if (createNew && exists) throw err("EEXIST", `${path} exists`);
      if (!exists && !create) throw err("ENOENT", `${path}: no such file`);
      if (exists && ((await cap.call("stat", path)) as PlainStat).isDirectory)
        throw err("EISDIR", `${path} is a directory`);
      // A refused create or truncate fails here. WASIX opens files for writing even to read
      // them, so writing an existing file is checked at the first write instead.
      if (write && (!exists || truncate)) await cap.call("writeFile", path, "");
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
      const b = await load(f);
      const at = Math.min(Number(offset), f.size);
      return b.slice(at, Math.min(f.size, at + Number(length)));
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
      const before = b.slice(at, end);
      const size = f.size;
      if (at > f.size) b.fill(0, f.size, at);
      b.set(data, at);
      f.size = Math.max(f.size, end);
      try {
        checkText(b, at, end, f.path);
      } catch (e) {
        b.set(before, at);
        f.size = size;
        throw e;
      }
      f.dirty = true;
      return data.length;
    },
    async setLen(id, length) {
      const f = handle(id).file;
      await mayWrite(f);
      await load(f);
      const n = Number(length);
      // Cutting a character in two would make the file unstorable, and only at close.
      if (n < f.size && isContinuation((f.bytes as Uint8Array)[n]))
        throw err("ENOTSUP", `${f.path}: the length would cut a UTF-8 character`);
      const b = reserve(f, n);
      if (n > f.size) b.fill(0, f.size, n);
      f.size = n;
      f.dirty = true;
      return null;
    },
    async fileStat(id) {
      const f = handle(id).file;
      const s = (await cap.call("exists", f.path))
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
      await cap.call("mkdir", abs(p));
      return null;
    },
    async remove(p) {
      const path = abs(p);
      // The store removes a directory only recursively: an empty one is removed that way.
      const s = (await cap.call("stat", path)) as PlainStat;
      if (s.isDirectory) {
        if ((await cap.readdir(path)).length) throw err("ENOTEMPTY", `${path} is not empty`);
        await cap.call("rm", path, { recursive: true });
      } else await cap.call("rm", path);
      const f = files.get(path);
      if (f) f.dirty = false;
      return null;
    },
    async rename(from, to) {
      const src = abs(from);
      const dst = abs(to);
      const f = files.get(src);
      if (f) await save(f);
      await cap.move("mv", src, dst);
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
    /** Open files of a sandbox that ends are dropped: what was not flushed is not written. */
    close() {
      handles.clear();
      files.clear();
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
