// Sources of the modules a bundled tool gets instead of Node builtins. They are strings:
// webrun-bundler inlines them as virtual modules. The fs shim talks only to the `files`
// capability the wrapper entry binds when the tool's isolate is called.

/** Virtual module ids (tool code reaches them only through the specifiers the config maps). */
export const FS_ID = "@capfs/fs";
export const FS_PROMISES_ID = "@capfs/fs-promises";
export const PATH_ID = "@capfs/path";
export const PROCESS_ID = "@capfs/process";
/** The identifier `define` maps `process` to; the injected PROCESS_ID module provides it. */
export const PROCESS_GLOBAL = "__capfs_process";

/**
 * node:fs over the capability. The store holds UTF-8 text: reads return a Buffer-like
 * Uint8Array (`toString(encoding)`), any encoding can be read, and writes of bytes that are not
 * valid UTF-8 are refused (EINVAL) instead of being corrupted.
 */
export const FS_SHIM = String.raw`
let files;
export function __bindFiles(f) { files = f; }
const ERRNO = { EACCES: -13, ENOENT: -2, EEXIST: -17, EISDIR: -21, ENOTDIR: -20, ENOTEMPTY: -39, EINVAL: -22, ENOSYS: -38, EPERM: -1, EIO: -5 };
const err = (e, syscall, path) => {
  const m = String((e && e.message) || e);
  const x = new Error(m);
  x.code = (m.match(/^(E[A-Z]+)\b/) || [])[1] || "EIO";
  x.errno = ERRNO[x.code] ?? -5;
  if (syscall) x.syscall = syscall;
  if (path !== undefined) x.path = path;
  return x;
};
const need = () => { if (!files) throw err("EACCES: no file capability bound"); return files; };
const cap = async (method, path, ...a) => {
  try { return await need().call(method, path, ...a); } catch (e) { throw err(e, method, path); }
};
const p = (x) => String(x instanceof URL ? x.pathname : x);

// ---- bytes and encodings (UTF-8 store) ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const norm = (e) => String(e || "utf8").toLowerCase().replace("-", "");
function encode(bytes, enc) {
  switch (norm(enc)) {
    case "utf8": return new TextDecoder().decode(bytes);
    case "latin1": case "binary": return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    case "ascii": return Array.from(bytes, (b) => String.fromCharCode(b & 127)).join("");
    case "hex": return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    case "base64": {
      let s = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
      }
      return s;
    }
    default: throw err("EINVAL: unsupported encoding '" + enc + "'");
  }
}
class ToolBuffer extends Uint8Array {
  toString(enc, start, end) { return encode(this.subarray(start ?? 0, end ?? this.length), enc); }
  toJSON() { return { type: "Buffer", data: Array.from(this) }; }
  equals(o) { return o.length === this.length && this.every((b, i) => b === o[i]); }
}
const toBuffer = (text) => { const u = new TextEncoder().encode(text); return new ToolBuffer(u.buffer, u.byteOffset, u.length); };
/** What can be stored: strings as is; bytes only if they are valid UTF-8. */
function toText(d, enc) {
  if (typeof d === "string") {
    if (norm(enc) === "utf8") return d;
    throw err("EINVAL: only utf8 strings can be written (store is UTF-8 text)");
  }
  if (ArrayBuffer.isView(d)) d = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  else if (d instanceof ArrayBuffer) d = new Uint8Array(d);
  else throw err("EINVAL: data must be a string, a TypedArray or an ArrayBuffer");
  try { return utf8.decode(d); } catch { throw err("EINVAL: binary data that is not UTF-8 cannot be stored"); }
}
const encodingOf = (o) => (typeof o === "string" ? o : o && o.encoding) || null;
const stats = (s) => {
  const t = new Date(s.mtime);
  return { ...s, mtime: t, atime: t, ctime: t, birthtime: t, mtimeMs: +t, atimeMs: +t, ctimeMs: +t, birthtimeMs: +t,
    isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => false };
};

async function readFile(path, o) {
  const s = await cap("readFile", p(path));
  const enc = encodingOf(o);
  return enc ? (norm(enc) === "utf8" ? s : encode(toBuffer(s), enc)) : toBuffer(s);
}
async function writeFile(path, data, o) { await cap("writeFile", p(path), toText(data, encodingOf(o))); }
async function appendFile(path, data, o) { await cap("appendFile", p(path), toText(data, encodingOf(o))); }
async function readdir(path, o) {
  let names;
  try { names = await need().readdir(p(path)); } catch (e) { throw err(e, "scandir", p(path)); }
  if (!(o && o.withFileTypes)) return names;
  return Promise.all(names.map(async (name) => {
    const s = await stat((p(path) === "/" ? "" : p(path)) + "/" + name);
    return { name, parentPath: p(path), path: p(path), isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: () => false };
  }));
}
async function stat(path) { return stats(await cap("stat", p(path))); }
async function mkdir(path, o) { await cap("mkdir", p(path), { recursive: !!(o && o.recursive) }); }
async function rm(path, o) { await cap("rm", p(path), { recursive: !!(o && o.recursive), force: !!(o && o.force) }); }
async function unlink(path) { await cap("rm", p(path), {}); }
async function rmdir(path, o) { await cap("rm", p(path), { recursive: !!(o && o.recursive) }); }
async function realpath(path) { return cap("realpath", p(path)); }
/** Existence only: the capability has no per-mode probe (a write is authorized when it happens). */
async function access(path) { if (!(await cap("exists", p(path)))) throw err("ENOENT: no such file or directory, access '" + p(path) + "'", "access", p(path)); }
const move = async (kind, s, d, o) => { try { await need().move(kind, p(s), p(d), o); } catch (e) { throw err(e, kind, p(s)); } };
async function copyFile(src, dst) { await move("cp", src, dst); }
async function cp(src, dst, o) { await move("cp", src, dst, { recursive: !!(o && o.recursive) }); }
async function rename(src, dst) { await move("mv", src, dst); }

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 };
export const promises = { readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir, realpath, access, copyFile, cp, rename, constants };
// One module serves "fs": with a trailing callback a function calls back
// (fs.readFile(p, "utf8", cb)); without one it returns a promise.
const dual = (fn) => (...a) => {
  if (typeof a[a.length - 1] !== "function") return fn(...a);
  const cb = a.pop();
  fn(...a).then((v) => cb(null, v), (e) => cb(e));
};
const refuse = (name) => () => { throw err("ENOSYS: fs." + name + " is not available to tools; use the async API", name); };
const REFUSED = ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "readdirSync", "statSync", "lstatSync",
  "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "cpSync", "realpathSync", "accessSync",
  "openSync", "closeSync", "readSync", "writeSync", "open", "close", "read", "write", "opendir", "opendirSync",
  "createReadStream", "createWriteStream", "watch", "watchFile", "symlink", "symlinkSync", "link", "linkSync",
  "readlink", "readlinkSync", "chmod", "chmodSync", "chown", "chownSync", "utimes", "utimesSync"];
const api = {
  ...Object.fromEntries(Object.entries(promises).filter(([k]) => k !== "constants").map(([k, f]) => [k, dual(f)])),
  ...Object.fromEntries(REFUSED.map((n) => [n, refuse(n)])),
  promises, constants,
  exists: (path, cb) => cap("exists", p(path)).then((v) => cb(v), () => cb(false)),
};
export default api;
export const { readFile: _readFile, writeFile: _writeFile, appendFile: _appendFile, readdir: _readdir, stat: _stat,
  lstat, mkdir: _mkdir, rm: _rm, unlink: _unlink, rmdir: _rmdir, realpath: _realpath, access: _access,
  copyFile: _copyFile, cp: _cp, rename: _rename, exists,
  readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, rmSync,
  rmdirSync, unlinkSync, renameSync, copyFileSync, cpSync, realpathSync, accessSync, openSync, closeSync, readSync,
  writeSync, open, close, read, write, opendir, opendirSync, createReadStream, createWriteStream, watch, watchFile,
  symlink, symlinkSync, link, linkSync, readlink, readlinkSync, chmod, chmodSync, chown, chownSync, utimes, utimesSync } = api;
export { _readFile as readFile, _writeFile as writeFile, _appendFile as appendFile, _readdir as readdir, _stat as stat,
  _mkdir as mkdir, _rm as rm, _unlink as unlink, _rmdir as rmdir, _realpath as realpath, _access as access,
  _copyFile as copyFile, _cp as cp, _rename as rename };
`;

/** node:fs/promises: the promise API of the shared fs shim (same functions, same binding). */
export const FS_PROMISES_SHIM = `
import { promises } from ${JSON.stringify(FS_ID)};
export const { readFile, writeFile, appendFile, readdir, stat, lstat, mkdir, rm, unlink, rmdir, realpath, access, copyFile, cp, rename, constants } = promises;
export default promises;
`;

/** A small pure POSIX path: no host access. Relative paths resolve against "/". */
export const PATH_SHIM = String.raw`
export const sep = "/", delimiter = ":";
export function normalize(x) {
  if (x === "") return ".";
  const abs = x.startsWith("/"), trailing = x.endsWith("/"), out = [];
  for (const s of x.split("/")) { if (!s || s === ".") continue; if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); } else out.push(s); }
  let r = (abs ? "/" : "") + out.join("/");
  if (!r) r = abs ? "/" : ".";
  return trailing && r !== "/" ? r + "/" : r;
}
export const join = (...a) => { const j = a.filter((x) => x !== "").join("/"); return j ? normalize(j) : "."; };
export const isAbsolute = (x) => x.startsWith("/");
export function resolve(...a) { let r = ""; for (const x of a) if (x) r = x.startsWith("/") ? x : r + "/" + x; const n = normalize("/" + r); return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n; }
export function dirname(x) { if (!x) return "."; const n = x.length > 1 ? x.replace(/\/+$/, "") : x, i = n.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i); }
export function basename(x, ext) { const b = x.replace(/\/+$/, "").split("/").pop() || ""; return ext && b !== ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; }
export function extname(x) { const b = basename(x), i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; }
export function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean), t = resolve(to).split("/").filter(Boolean);
  let i = 0; while (i < f.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
}
export function parse(x) {
  const root = x.startsWith("/") ? "/" : "", base = basename(x), ext = extname(x);
  let dir = dirname(x); if (dir === "." && !x.startsWith(".")) dir = "";
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}
export function format(o) { const dir = o.dir || o.root || ""; const base = o.base || (o.name || "") + (o.ext || ""); return dir ? (dir === o.root ? dir + base : dir + "/" + base) : base; }
export const toNamespacedPath = (x) => x;
const no = () => { throw new Error("ENOSYS: path.win32 is not available to tools"); };
export const win32 = new Proxy({}, { get: no });
export const posix = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath, win32 };
posix.posix = posix;
export default posix;
`;

/** `process` for bundled tools: no host access; env from the config (NODE_ENV by default). */
export const processShim = (env: Record<string, string>): string => `
const env = Object.freeze(${JSON.stringify(env)});
export const ${PROCESS_GLOBAL} = Object.freeze({
  env, argv: Object.freeze([]), platform: "browser", version: "", versions: Object.freeze({}),
  cwd: () => "/", nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
});
`;

/**
 * A builtin a tool may not use: importing works (default and the builtin's own named exports,
 * when known), any use throws ENOSYS.
 */
export function denyModule(spec: string, names: string[] = []): string {
  const valid = names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
  return [
    `const no = () => { throw new Error("ENOSYS: ${spec} is not available to tools"); };`,
    "const denied = new Proxy(function () {}, { get: no, apply: no, construct: no });",
    "export default denied;",
    ...valid.map((n) => `export const ${n} = denied;`),
  ].join("\n");
}

/** Re-export one shared module, so every spelling (`fs`, `node:fs`, …) binds the same instance. */
export const reexport = (id: string): string =>
  `export * from ${JSON.stringify(id)}; export { default } from ${JSON.stringify(id)};`;

/**
 * The bundle's entry: a WorkerEntrypoint whose `run(files, input)` binds the capability for the
 * fs shim, then calls the tool's `run(input)` (or its default export, a function).
 */
export const wrapperEntry = (toolPath: string): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
import { __bindFiles } from ${JSON.stringify(FS_ID)};
import * as tool from ${JSON.stringify(toolPath)};
export default class extends WorkerEntrypoint {
  async run(files, input) {
    __bindFiles(files ?? this.env?.FILES); // argument (stub transport) or binding (token transport)
    const fn = typeof tool.run === "function" ? tool.run : tool.default;
    if (typeof fn !== "function") throw new Error("EINVAL: a tool exports run(input) or a default function");
    try {
      return await fn(input);
    } catch (e) {
      if (e instanceof TypeError && /without 'new'/.test(e.message)) {
        throw new Error("EINVAL: the tool's default export is a class; export run(input) or a function");
      }
      throw e;
    }
  }
}
`;
