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

interface Handle {
  path: string;
  append: boolean;
  bytes: Uint8Array | undefined;
  dirty: boolean;
}

/** The store keeps UTF-8 text, so a file's bytes must decode. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();
/** At most this many open files per sandbox; at most this many bytes per file in memory. */
const MAX_HANDLES = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const nanos = (iso: string) => String(BigInt(Date.parse(iso) || 0) * 1_000_000n);

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
  const load = async (h: Handle) => {
    if (!h.bytes)
      h.bytes = (await cap.call("exists", h.path))
        ? encoder.encode((await cap.call("readFile", h.path)) as string)
        : new Uint8Array();
    return h.bytes;
  };
  const save = async (h: Handle) => {
    if (!h.dirty || !h.bytes) return;
    let text: string;
    try {
      text = decoder.decode(h.bytes);
    } catch {
      throw err("ENOTSUP", `${h.path}: the store keeps UTF-8 text, not binary content`);
    }
    await cap.call("writeFile", h.path, text);
    h.dirty = false;
  };
  const resize = (b: Uint8Array, length: number) => {
    if (length > MAX_FILE_BYTES) throw err("EFBIG", `files are at most ${MAX_FILE_BYTES} bytes`);
    const out = new Uint8Array(length);
    out.set(b.subarray(0, Math.min(b.length, length)));
    return out;
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
      const h: Handle = { path, append: !!append, bytes: undefined, dirty: false };
      if (write && (!exists || truncate)) {
        // Written through at once: a refused write fails at open, as on a real file system.
        h.bytes = new Uint8Array();
        h.dirty = true;
        await save(h);
      }
      const id = next++;
      handles.set(id, h);
      return id;
    },
    async read(id, offset, length) {
      const b = await load(handle(id));
      const at = Number(offset);
      return b.subarray(at, at + Number(length));
    },
    async write(id, offset, bytes) {
      const h = handle(id);
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[]);
      const b = await load(h);
      const at = h.append ? b.length : Number(offset);
      const out = resize(b, Math.max(b.length, at + data.length));
      out.set(data, at);
      h.bytes = out;
      h.dirty = true;
      return data.length;
    },
    async setLen(id, length) {
      const h = handle(id);
      h.bytes = resize(await load(h), Number(length));
      h.dirty = true;
      return null;
    },
    async fileStat(id) {
      const h = handle(id);
      const s = (await cap.call("exists", h.path))
        ? await stat(h.path)
        : { kind: "file", size: 0, modified: "0", accessed: "0", created: "0" };
      return { ...s, size: h.bytes ? h.bytes.length : s.size };
    },
    async flush(id) {
      await save(handle(id));
      return null;
    },
    async close(id) {
      const h = handles.get(Number(id));
      handles.delete(Number(id));
      if (h) await save(h);
      return null;
    },
    async mkdir(p) {
      await cap.call("mkdir", abs(p));
      return null;
    },
    async remove(p) {
      await cap.call("rm", abs(p));
      return null;
    },
    async rename(from, to) {
      await cap.move("mv", abs(from), abs(to));
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
