// The Python engine: Pyodide (CPython on WebAssembly) in a realm of its own.
//   Node:    a child process started by the kernel with Node's permission model (it may read
//            only Pyodide's files and this script; no writes, no child processes, no workers)
//            and with code generation from strings disabled.
//   Browser: a module Worker served with a restrictive CSP; after Pyodide has loaded, the
//            network and storage APIs are removed from the Worker's global scope.
// It never sees the capability object. It talks to the kernel (in the Agent cell) by messages:
//   kernel → engine  {type:"init", indexURL}
//                    {type:"run", id, code, files:{"/proj/a.txt": "…"}, cwd}
//                    {type:"capResult", id, ok, value | error}
//   engine → kernel  {type:"ready", version} | {type:"failed", error}
//                    {type:"cap", id, method, args}                 (the live `capfs` module)
//                    {type:"result", id, stdout, stderr, value, error, changes}
// Files: before a run the kernel copies the readable files under its root into /workspace;
// after the run the engine reports what changed there, and the kernel writes it back through
// the capability, so every write is authorized again.

const IN_NODE = typeof process === "object" && !!process.versions?.node;
const WORKSPACE = "/workspace";

// ---- transport ----
let send;
let onMessage;
if (IN_NODE) {
  send = (m) => process.send?.(m);
  onMessage = (fn) => process.on("message", fn);
  process.on("disconnect", () => process.exit(0)); // the kernel went away
} else {
  send = (m) => self.postMessage(m);
  onMessage = (fn) => self.addEventListener("message", (e) => fn(e.data));
}

// ---- live capability calls (the `capfs` Python module) ----
// Every call carries the id of the run it belongs to; the kernel answers it with THAT run's
// capability, or refuses it. Outside a run (a task left behind by an earlier run) nothing is sent.
let nextCap = 0;
let currentRun = null;
const pendingCaps = new Map();
/**
 * `run` is the run that started the calling Python code (a contextvar copied into every task it
 * creates); a call from a task an earlier run left behind is refused, even while another run is
 * active.
 */
function capCall(run, method, ...args) {
  if (currentRun === null || run !== currentRun) {
    return Promise.reject(new Error("EACCES: capfs call outside its run"));
  }
  const id = ++nextCap;
  send({ type: "cap", id, run, method, args });
  return new Promise((ok, ko) => pendingCaps.set(id, { ok, ko, run }));
}

// What one run may send back (the kernel checks again).
const LIMITS = { stream: 1024 * 1024, value: 64 * 1024, files: 5000, bytes: 16 * 1024 * 1024 };
const clip = (s, n) =>
  s.length > n ? `${s.slice(0, n)}\n… [truncated ${s.length - n} characters]` : s;

let pyodide;
let baselineModules;
let baselinePath;
const out = { stdout: [], stderr: [] };

async function init(indexURL) {
  let loadPyodide;
  if (IN_NODE) {
    // Pyodide's Node file system asks process.binding("constants") for fs flags, which the
    // permission model refuses: give it exactly those constants.
    const { constants } = await import("node:fs");
    process.binding = (name) => {
      if (name === "constants") return { fs: constants };
      throw new Error("process.binding is not available");
    };
    ({ loadPyodide } = await import(new URL("pyodide.mjs", `file://${indexURL}`).href));
  } else {
    ({ loadPyodide } = await import(
      new URL("pyodide.mjs", new URL(indexURL, self.location.href)).href
    ));
  }
  pyodide = await loadPyodide({
    indexURL,
    jsglobals: Object.freeze({}), // the `js` module sees nothing of this realm
    stdout: (s) => out.stdout.push(s),
    stderr: (s) => out.stderr.push(s),
  });
  pyodide.registerJsModule("_capfs_js", capfsModule());
  pyodide.runPython(CAPFS_PY);
  pyodide.FS.mkdirTree(WORKSPACE);
  baselineModules = new Set(pyodide.runPython("import sys\nlist(sys.modules)").toJs());
  baselinePath = pyodide.runPython("import sys, json\njson.dumps(sys.path)");
  lockdown();
  return pyodide.version;
}

/** After Pyodide has loaded: no network or storage APIs are left in this realm. */
function lockdown() {
  const g = globalThis;
  const names = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "importScripts",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "indexedDB",
    "caches",
    "Request",
    "Response",
  ];
  for (const n of names) {
    try {
      delete g[n];
      if (n in g)
        Object.defineProperty(g, n, { value: undefined, configurable: false, writable: false });
    } catch {}
  }
  if (!IN_NODE && g.navigator) {
    for (const target of [g.navigator, Object.getPrototypeOf(g.navigator)]) {
      for (const n of ["storage", "locks", "serviceWorker", "sendBeacon"]) {
        try {
          Object.defineProperty(target, n, { value: undefined, configurable: false });
        } catch {}
      }
    }
  }
}

/** The JS half of `capfs`: every function takes the caller's run id first. */
function capfsModule() {
  const p = (x) => {
    const s = String(x);
    return s === WORKSPACE ? "/" : s.startsWith(`${WORKSPACE}/`) ? s.slice(WORKSPACE.length) : s;
  };
  return {
    // Bytes only reach the capability. Over the kernel's JSON channel they travel as files do: a
    // string when they are valid UTF-8, else { $b64 }. Text is encoded and decoded here.
    read_bytes: async (run, path) => fromContent(await capCall(run, "readFileBuffer", p(path))),
    write_bytes: (run, path, data) =>
      capCall(run, "writeFileBuffer", p(path), toContent(bytesOf(data))),
    append_bytes: (run, path, data) =>
      capCall(run, "appendFileBuffer", p(path), toContent(bytesOf(data))),
    read_text: async (run, path) =>
      lossyUtf8.decode(fromContent(await capCall(run, "readFileBuffer", p(path)))),
    write_text: (run, path, text) =>
      capCall(run, "writeFileBuffer", p(path), toContent(encoder.encode(String(text)))),
    append_text: (run, path, text) =>
      capCall(run, "appendFileBuffer", p(path), toContent(encoder.encode(String(text)))),
    listdir: async (run, path) => pyodide.toPy(await capCall(run, "readdir", p(path))),
    exists: (run, path) => capCall(run, "exists", p(path)),
    stat: async (run, path) => pyodide.toPy(await capCall(run, "stat", p(path))),
    mkdir: (run, path) => capCall(run, "mkdir", p(path), { recursive: true }),
    remove: (run, path) => capCall(run, "rm", p(path), { recursive: true }),
  };
}

/** Python: `import capfs; await capfs.read_text("/proj/a.txt")`: live, authorized calls. */
const CAPFS_PY = `
import sys, types, contextvars, _capfs_js
_run = contextvars.ContextVar("capfs_run", default=None)
capfs = types.ModuleType("capfs", "Live calls through the agent's file capability (paths in its namespace).")
capfs._run = _run
capfs.WORKSPACE = "${WORKSPACE}"
from pyodide.ffi import to_js as _to_js
async def read_text(path): return await _capfs_js.read_text(_run.get(), path)
async def write_text(path, text): return await _capfs_js.write_text(_run.get(), path, text)
async def append_text(path, text): return await _capfs_js.append_text(_run.get(), path, text)
async def read_bytes(path): return (await _capfs_js.read_bytes(_run.get(), path)).to_bytes()
async def write_bytes(path, data): return await _capfs_js.write_bytes(_run.get(), path, _to_js(bytes(data)))
async def append_bytes(path, data): return await _capfs_js.append_bytes(_run.get(), path, _to_js(bytes(data)))
async def listdir(path="/"): return await _capfs_js.listdir(_run.get(), path)
async def exists(path): return await _capfs_js.exists(_run.get(), path)
async def stat(path): return await _capfs_js.stat(_run.get(), path)
async def mkdir(path): return await _capfs_js.mkdir(_run.get(), path)
async def remove(path): return await _capfs_js.remove(_run.get(), path)
for f in (read_text, write_text, append_text, read_bytes, write_bytes, append_bytes, listdir, exists, stat, mkdir, remove):
    setattr(capfs, f.__name__, f)
sys.modules["capfs"] = capfs
del sys.modules["_capfs_js"]
`;

/** Sets the run id in the interpreter's main context (tasks copy it when they are created). */
function setRun(id) {
  const ns = pyodide.toPy({ ID: id });
  pyodide.runPython("import capfs\ncapfs._run.set(ID)", { globals: ns });
  ns.destroy?.();
}

// A leading U+FEFF is text: dropping it would make every BOM file look changed.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function writeWorkspace(files) {
  const FS = pyodide.FS;
  pyodide.runPython(
    `import shutil, os\nshutil.rmtree(${JSON.stringify(WORKSPACE)}, ignore_errors=True)\nos.makedirs(${JSON.stringify(WORKSPACE)}, exist_ok=True)`,
  );
  for (const [path, content] of Object.entries(files)) {
    const target = WORKSPACE + path;
    FS.mkdirTree(target.slice(0, target.lastIndexOf("/")) || WORKSPACE);
    FS.writeFile(target, typeof content === "string" ? content : fromB64(content.$b64));
  }
}

// A file's content to and from the kernel: UTF-8 text, or other bytes as { $b64 } (IPC is JSON).
const toB64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const encoder = new TextEncoder();
/** UTF-8 as the store decodes it: U+FFFD for invalid sequences, a leading U+FEFF kept. */
const lossyUtf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
/** Bytes as they cross the kernel's JSON channel: a string if valid UTF-8, else { $b64 }. */
const toContent = (b) => {
  try {
    return utf8.decode(b);
  } catch {
    return { $b64: toB64(b) };
  }
};
const fromContent = (c) =>
  typeof c === "string"
    ? encoder.encode(c)
    : c?.$b64 !== undefined
      ? fromB64(c.$b64)
      : new Uint8Array();
/** A Uint8Array from what Python passed (to_js of bytes gives one). */
const bytesOf = (d) =>
  d instanceof Uint8Array
    ? d
    : ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d);
const sameContent = (a, b) =>
  typeof a === "string" || typeof b === "string" ? a === b : a?.$b64 === b?.$b64;

/**
 * What changed under /workspace: written (text, or { $b64 } for other bytes), deleted files,
 * new dirs, removed dirs (the topmost of each removed tree). Bounded by LIMITS.
 */
function changes(before) {
  const FS = pyodide.FS;
  const written = {};
  const dirs = [];
  const seen = new Set();
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const walk = (dir) => {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const full = `${dir}/${name}`;
      const rel = full.slice(WORKSPACE.length);
      const mode = FS.stat(full).mode;
      if (FS.isDir(mode)) {
        if (!hasPrefix(before, rel)) dirs.push(rel);
        walk(full);
      } else if (FS.isFile(mode)) {
        seen.add(rel);
        const raw = FS.readFile(full);
        let content;
        try {
          content = utf8.decode(raw);
        } catch {
          content = { $b64: toB64(raw) };
        }
        if (!sameContent(before[rel], content)) {
          files += 1;
          bytes += raw.length;
          if (files > LIMITS.files || bytes > LIMITS.bytes) {
            truncated = true;
            continue;
          }
          written[rel] = content;
        }
      }
    }
  };
  walk(WORKSPACE);
  const deleted = Object.keys(before).filter((p) => !seen.has(p));
  // Directories that held synced files and are gone now: report the topmost of each tree.
  const exists = (p) => FS.analyzePath(WORKSPACE + p).exists;
  const gone = new Set();
  for (const p of deleted) {
    for (let d = p.slice(0, p.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/")))
      if (!exists(d)) gone.add(d);
  }
  const deletedDirs = [...gone].filter((d) => !gone.has(d.slice(0, d.lastIndexOf("/")))).sort();
  return { written, deleted, dirs, deletedDirs, truncated };
}
const hasPrefix = (files, dir) => Object.keys(files).some((p) => p.startsWith(`${dir}/`));

async function run({ id, code, files, cwd }) {
  out.stdout.length = 0;
  out.stderr.length = 0;
  let value;
  let error;
  currentRun = id;
  setRun(id);
  try {
    writeWorkspace(files);
    const dir = WORKSPACE + (cwd && cwd !== "/" ? cwd : "");
    pyodide.FS.mkdirTree(dir);
    pyodide.FS.chdir(dir);
    const globals = pyodide.toPy({ __name__: "__main__" });
    const r = await pyodide.runPythonAsync(code, { globals });
    value = r === undefined || r === null ? null : typeof r === "object" && r.toJs ? String(r) : r;
    if (typeof value === "string") value = clip(value, LIMITS.value);
    r?.destroy?.();
    globals.destroy?.();
  } catch (e) {
    error = String(e?.message ?? e);
  }
  // The run is over: tasks it left behind are cancelled, and their capfs calls are refused.
  currentRun = null;
  setRun(null);
  try {
    pyodide.runPython(
      "import asyncio\nfor t in asyncio.all_tasks(asyncio.get_event_loop()):\n    t.cancel()",
    );
  } catch {}
  for (const [capId, p] of pendingCaps) {
    if (p.run !== id) continue;
    pendingCaps.delete(capId);
    p.ko(new Error("EACCES: the run is over"));
  }
  let result;
  try {
    result = changes(files);
  } catch (e) {
    result = { written: {}, deleted: [], dirs: [], deletedDirs: [], truncated: false };
    error = `${error ? `${error}\n` : ""}cannot read /workspace: ${e?.message ?? e}`;
  }
  // Modules a run imported (its own, or stdlib) are dropped: the next run starts from the baseline.
  try {
    const ns = pyodide.toPy({ BASE: JSON.stringify([...baselineModules]), PATH: baselinePath });
    pyodide.runPython(
      "import sys, json\nb = set(json.loads(BASE))\nfor k in [k for k in sys.modules if k not in b]:\n    del sys.modules[k]\nsys.path[:] = json.loads(PATH)",
      { globals: ns },
    );
    ns.destroy?.();
  } catch {}
  send({
    type: "result",
    id,
    stdout: clip(out.stdout.join("\n"), LIMITS.stream),
    stderr: clip(out.stderr.join("\n"), LIMITS.stream),
    value,
    error,
    changes: result,
  });
}

onMessage(async (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "init") {
    try {
      send({ type: "ready", version: await init(m.indexURL) });
    } catch (e) {
      send({ type: "failed", error: String(e?.stack ?? e) });
    }
  } else if (m.type === "run") {
    await run(m);
  } else if (m.type === "capResult") {
    const p = pendingCaps.get(m.id);
    if (!p) return;
    pendingCaps.delete(m.id);
    if (m.ok) p.ok(m.value);
    else p.ko(new Error(m.error));
  }
});
