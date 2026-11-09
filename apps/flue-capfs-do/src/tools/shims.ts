// Sources of the modules a bundled tool gets instead of Node builtins. They are strings:
// webrun-bundler inlines them as virtual modules. The fs shim talks only to the `files`
// capability the wrapper entry binds when the tool's isolate is called.

/** Virtual module ids (not importable by tool code under these names: the bundler maps them). */
export const FS_ID = "@capfs/fs";
export const PATH_ID = "@capfs/path";

/** node:fs over the capability: async API (promises and callbacks); sync API refused. */
export const FS_SHIM = String.raw`
let files;
export function __bindFiles(f) { files = f; }
const err = (e) => {
  const m = String((e && e.message) || e);
  const x = new Error(m);
  x.code = (m.match(/^(E[A-Z]+)\b/) || [])[1] || "EIO";
  return x;
};
const cap = async (method, ...a) => {
  if (!files) throw err("EACCES: no file capability bound");
  try { return await files.call(method, ...a); } catch (e) { throw err(e); }
};
const enc = new TextEncoder();
const text = (d) => (typeof d === "string" ? d : d instanceof Uint8Array ? new TextDecoder().decode(d) : String(d));
const encodingOf = (o) => (typeof o === "string" ? o : o && o.encoding) || null;
const stats = (s) => ({ ...s, mtime: new Date(s.mtime), isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => false });
const p = (x) => String(x instanceof URL ? x.pathname : x);

async function readFile(path, o) { const s = await cap("readFile", p(path)); return encodingOf(o) ? s : enc.encode(s); }
async function writeFile(path, data) { await cap("writeFile", p(path), text(data)); }
async function appendFile(path, data) { await cap("appendFile", p(path), text(data)); }
async function readdir(path, o) {
  let names;
  try { names = await files.readdir(p(path)); } catch (e) { throw err(e); }
  if (!(o && o.withFileTypes)) return names;
  return Promise.all(names.map(async (name) => {
    const s = await stat((p(path) === "/" ? "" : p(path)) + "/" + name);
    return { name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: () => false };
  }));
}
async function stat(path) { return stats(await cap("stat", p(path))); }
async function mkdir(path, o) { await cap("mkdir", p(path), { recursive: !!(o && o.recursive) }); }
async function rm(path, o) { await cap("rm", p(path), { recursive: !!(o && o.recursive), force: !!(o && o.force) }); }
async function unlink(path) { await cap("rm", p(path), {}); }
async function rmdir(path, o) { await cap("rm", p(path), { recursive: !!(o && o.recursive) }); }
async function access(path) { if (!(await cap("exists", p(path)))) throw err("ENOENT: no such file or directory, access '" + p(path) + "'"); }
async function copyFile(src, dst) { try { await files.move("cp", p(src), p(dst)); } catch (e) { throw err(e); } }
async function cp(src, dst, o) { try { await files.move("cp", p(src), p(dst), { recursive: !!(o && o.recursive) }); } catch (e) { throw err(e); } }
async function rename(src, dst) { try { await files.move("mv", p(src), p(dst)); } catch (e) { throw err(e); } }

export const promises = { readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir, access, copyFile, cp, rename };
// One module serves "fs" and "fs/promises": with a trailing callback a function calls back
// (fs.readFile(p, "utf8", cb)); without one it returns a promise (await readFile(p, "utf8")).
const dual = (fn) => (...a) => {
  if (typeof a[a.length - 1] !== "function") return fn(...a);
  const cb = a.pop();
  fn(...a).then((v) => cb(null, v), (e) => cb(e));
};
const sync = (name) => () => { throw err("ENOSYS: fs." + name + " is not available to tools; use the async API"); };
const api = {
  ...Object.fromEntries(Object.entries(promises).map(([k, f]) => [k, dual(f)])),
  promises,
  exists: (path, cb) => cap("exists", p(path)).then((v) => cb(v), () => cb(false)),
  readFileSync: sync("readFileSync"), writeFileSync: sync("writeFileSync"), existsSync: sync("existsSync"),
  readdirSync: sync("readdirSync"), statSync: sync("statSync"), mkdirSync: sync("mkdirSync"),
  createReadStream: sync("createReadStream"), createWriteStream: sync("createWriteStream"), openSync: sync("openSync"),
};
export const { readFile: _readFile, writeFile: _writeFile, appendFile: _appendFile, readdir: _readdir, stat: _stat, lstat,
  mkdir: _mkdir, rm: _rm, unlink: _unlink, rmdir: _rmdir, access: _access, copyFile: _copyFile, cp: _cp, rename: _rename,
  existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, createReadStream, createWriteStream, openSync } = api;
export { _readFile as readFile, _writeFile as writeFile, _appendFile as appendFile, _readdir as readdir, _stat as stat,
  _mkdir as mkdir, _rm as rm, _unlink as unlink, _rmdir as rmdir, _access as access, _copyFile as copyFile, _cp as cp, _rename as rename };
export const exists = api.exists;
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export default api;
`;

/** A small pure POSIX path: no host access, enough for common tools. */
export const PATH_SHIM = String.raw`
export const sep = "/", delimiter = ":";
export function normalize(x) {
  const abs = x.startsWith("/"), out = [];
  for (const s of x.split("/")) { if (!s || s === ".") continue; if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); } else out.push(s); }
  const r = (abs ? "/" : "") + out.join("/");
  return r || (abs ? "/" : ".");
}
export const join = (...a) => normalize(a.filter(Boolean).join("/") || ".");
export const isAbsolute = (x) => x.startsWith("/");
export function resolve(...a) { let r = ""; for (const x of a) r = x.startsWith("/") ? x : r + "/" + x; return normalize(r.startsWith("/") ? r : "/" + r); }
export function dirname(x) { const n = normalize(x), i = n.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i); }
export function basename(x, ext) { const b = normalize(x).split("/").pop() || ""; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; }
export function extname(x) { const b = basename(x), i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; }
export function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean), t = resolve(to).split("/").filter(Boolean);
  let i = 0; while (i < f.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
}
export const posix = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative };
export default posix;
`;

/** A builtin a tool may not use: importing works, any use throws. */
export const denyModule = (spec: string): string =>
  `const no = () => { throw new Error("ENOSYS: ${spec} is not available to tools"); };
export default new Proxy({}, { get: no, apply: no });`;

/** Re-export one shared module, so every spelling (`fs`, `node:fs`, …) binds the same instance. */
export const reexport = (id: string): string =>
  `export * from ${JSON.stringify(id)}; export { default } from ${JSON.stringify(id)};`;

/**
 * The bundle's entry: a WorkerEntrypoint whose `run(files, input)` binds the capability for the
 * fs shim, then calls the tool's `run(input)` (or its default export).
 */
export const wrapperEntry = (toolPath: string): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
import { __bindFiles } from ${JSON.stringify(FS_ID)};
import * as tool from ${JSON.stringify(toolPath)};
export default class extends WorkerEntrypoint {
  async run(files, input) {
    __bindFiles(files);
    const fn = typeof tool.run === "function" ? tool.run : tool.default;
    if (typeof fn !== "function") throw new Error("EINVAL: a tool exports run(input) or a default function");
    return fn(input);
  }
}
`;
