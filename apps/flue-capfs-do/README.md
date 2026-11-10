# flue-capfs-do

## What it is

A working prototype of **Flue agents on Durable Objects with a rights-filtered file system**.
Each agent gets one file system, filtered by the current user's rights. The rights are Biscuit
tokens with Datalog policies. They can change at runtime and can be delegated, only ever
narrower, from an agent to sub-agents and tools. Agents and tools reach file data only through a
capability.

It is one ordinary Worker project (`wrangler.jsonc`, `src/worker.ts`). The same project runs
unchanged on **wrangler** (workerd), on **cellb** (Node), on cellb with its cells in **celld's
bucket format**, and on **celld** itself. One HTTP scenario suite checks every runtime.

It turns the prototypes and the guide from the 8 Nov 2026 session (Drive folder
`2026-11-08.Flue-Cellb`, notes 01–13) into a deployable project.

## Why it exists

Yesterday's prototypes proved each idea in isolation, inside one Node test process. This app
makes them a real deployment shape:

- The store is real and durable: a file system on the owner Durable Object's own SQLite, not
  `InMemoryFs`.
- Session state (mode, revocations) and the root key are durable. A restart keeps them.
- Delegation goes across real Durable Object cells over the runtime's RPC.
- The agent side is Flue's own toolset (`read`, `write`, `edit`, `grep`, `glob`, `bash`), running
  on the same sandbox a Flue agent's `useSandbox(bash(...))` gets.
- Untrusted tool code runs in a fresh Worker Loader isolate for each call. It has no network
  and only the narrowed capability: an RpcTarget argument, or with the token transport a single
  `env.FILES` binding that works only while the call runs. On runtimes whose isolates can see the host's
  files (cellb on Node), tool tasks are refused.

## How to run it

```sh
pnpm install                                        # at the repository root
pnpm --filter @statewalker/flue-capfs-do test       # unit + cellb + cellb(celld bucket) + wrangler
pnpm --filter @statewalker/flue-capfs-do test:celld # celld in Docker (or CELLD_BIN), token transport
```

Each `test:<env>` runs `scripts/run-env.mjs <env>`. That script starts the runtime on a free
port with fresh state, runs `tests/scenario.test.mjs`, and writes the durability fixture. It then
**restarts the runtime on the same state** (checked by a new boot id) and checks the fixture
again.

| Script | Runtime |
|---|---|
| `test:unit` | the authorization core and the store on `node:sqlite`, without a runtime |
| `test:wrangler` | `wrangler dev` (workerd 2026-11-04) |
| `test:cellb` | `@statewalker/cellb` 0.5.2 `loadProject`, cells in `node:sqlite` files |
| `test:cellb-bundled-only` | cellb with `TOOL_BUNDLE={"hostFsRuntimes":"bundled-only","allowedBundles":[<hash of tests/fixtures/todo-tool.ts>]}`: that approved bundle runs, other bundles and raw tools are refused |
| `test:cellb-celld-bucket` | cellb with `celldBucket(sqliteObjectStore(...))`: cells as celld writes them (LTX logs, `own.json` ownership records), in the object store `celld dev` keeps |
| `test:browser` | the project in Chromium on cellb (Playwright): builds `dist/`, serves it, runs the capability checks and the Python cases through the page |
| `test:celld` | `celld dev <project> --host 127.0.0.1 --port <port> --no-watch`, with `--clean` on the first start only. By default this uses the `ghcr.io/denoland/celld:0.6.0` image in Docker (`CELLD_IMAGE`): host networking, the repository mounted at its own path, the container running as the host user, and the project's Linux esbuild as `CELLD_ESBUILD`. That needs a Linux host; elsewhere, set `CELLD_BIN` to a local celld. The state is the project's `.celld/dev`, so don't run two celld runs at once. It runs with `TRANSPORTS=token` (below) |

For interactive use, start a runtime with `pnpm dev:wrangler` (port 8787) or `pnpm dev:cellb`
(port 8788). Then run the guided tour, `pnpm example`
([`examples/walkthrough.mjs`](examples/walkthrough.mjs); set `BASE_URL` for cellb). It covers a
session, bash, Flue tools, a mode switch, delegation, a tool isolate and revocation, and prints
each step. You can also call the API by hand:

```sh
A='authorization: Bearer dev-admin-key'; J='content-type: application/json'
curl -H "$A" -H "$J" localhost:8787/api/w/acme/seed -d '{"files":{"/proj/readme.md":"# hi\nTODO: spec\n","/hr/salaries.csv":"..."}}'
curl -H "$A" -H "$J" localhost:8787/api/w/acme/sessions -d '{"user":"alice","rights":["/proj","/plans"],"mode":"yolo"}'
# → {"value":{"session":"…","token":"…"}}
curl -H "$J" localhost:8787/api/agents/alice-1/run -d '{"workspace":"acme","token":"…","transport":"stub",
  "task":{"kind":"bash","script":"ls /; grep -r hi /proj"}}'
curl -H "$A" -H "$J" localhost:8787/api/w/acme/sessions/<session>/mode -d '{"mode":"plan"}'
```

## How to use

### HTTP surface (`src/worker.ts`)

| Route | Who | Does |
|---|---|---|
| `POST /api/w/:ws/seed` `{files}` | admin | writes files without rights checks (import) |
| `GET /api/w/:ws/files` | admin | every file and its contents (audit) |
| `GET /api/w/:ws/stats` | admin | `{authorizations, verifications}` of the Workspace instance |
| `GET /api/w/:ws/sessions/:sid` | admin | `{session, user, mode, revokedAll, revokedIds}` |
| `POST /api/w/:ws/sessions` `{user, rights, mode}` | admin | mints a session token → `{session, token}` |
| `POST /api/w/:ws/sessions/:sid/mode` `{mode}` | admin | `yolo` · `prototyping` · `plan` · `readonly` |
| `POST /api/w/:ws/sessions/:sid/revoke` `{rid?}` | admin | revokes one capability (and its descendants), or the whole session |
| `POST /api/agents/:name/run` `{workspace, token, transport, chain?, task}` | user | runs a task in the agent cell |
| `GET /api/runtime` | any | `{workerLoader, toolIsolates, requireBundled, allowedBundles, userAgent, bootId}`; `toolIsolates` is `isolated`, `bundled-only`, `refused` or `none`; `allowedBundles` is a count; an invalid `TOOL_BUNDLE` shows `toolConfigError` and `refused` |

Admin routes need `Authorization: Bearer <key>` and fail closed:

- `ADMIN_KEY`: the deployment key. Set it as a secret (`wrangler secret put ADMIN_KEY`).
- `DEV_ADMIN_KEY`: the development key (`dev-admin-key` in `wrangler.jsonc`). It is accepted only
  for requests addressed to `localhost`, `127.0.0.1` or `[::1]`, so a project deployed as-is has
  no working admin key.
- Neither set: every admin route answers 401. Keys are compared in constant time.

In production, the gateway authenticates the user and reads their rights from the namespace
configuration. Starting a session also creates the right directories (`/proj`, …), because
agents cannot create directories above their rights.

Tasks:

- `{kind: "bash", script, cwd?}` runs a just-bash shell over the capability.
- `{kind: "flue", calls: [{tool, params}], cwd?}` calls Flue's tools as a model would.
- `{kind: "tool", code, input?, bundled?}` runs a module in a new Worker Loader isolate (one per
  call, so no state survives between callers). The module exports
  `default class extends WorkerEntrypoint { run(files, input) }`. `files` is the narrowed
  capability as an RpcTarget with the stub transport. With the token transport it is `null`,
  and `this.env.FILES` holds it instead: a loopback service binding
  (`ctx.exports.ToolFilesEntrypoint` with the token in its props, which the tool cannot read).
  This is the form that works on celld. So `files ??= this.env.FILES` works everywhere. Either
  form stops working when `run` returns: the RpcTarget is disposed, and every call through the
  binding first asks the Agent cell whether the run named in its props is still active. With `bundled: true` the code
  is a bundle from `bundleTool` (see [Bundled tools](#bundled-tools)), and the Agent runs the
  acceptance check before loading it. Whether a raw module or a bundle may run depends on
  `toolIsolates` (below).
- `{kind: "python", code, root?, cwd?, timeoutMs?, fresh?}` runs Python (Pyodide) on the
  capability's files (see [Python](#python)).
- `{kind: "revocationId"}` returns the revocation id of the capability the agent holds.

`chain: [{scope?, readOnly?, datalog?}, …]` adds one hop per entry. Each hop attenuates the
capability and hands it to a new sub-agent cell (`<name>/sub`, `<name>/sub/sub`, …), and the
last hop runs the task. `datalog` is any Biscuit check, for example
`check if resource($p), !$p.starts_with("/proj/secret/");`. It holds for recursive operations
too, because every entry they touch is authorized.

### The two capability transports

| | `transport: "stub"` | `transport: "token"` |
|---|---|---|
| What the agent holds | an RPC stub of `FilteredFiles` (an `RpcTarget` in the Workspace cell) | the Biscuit token string and the workspace name |
| Attenuation | RPC: the owner creates the narrower capability | local and offline: appending a block needs no key |
| Survives hibernation and restarts | no (stubs are per-connection) | yes (the token can be stored) |
| Crosses runtimes and nodes | no (`DataCloneError`) | yes |

Both transports go through the same `FsGate` and `Authority` in the owner cell, so the rules,
the mode and the revocations are identical.

### Datalog (`src/policy.ts`)

For each path, the authorizer provides `operation(op)` (`read`, `list` or `write`) and
`resource(path + "/")`, bound as parameters. The authority block holds `user`, `session` and
`right("/p1/")` facts. The owner reads the session from the authority block and applies THAT
session's mode and revocations; attenuation blocks cannot change it. Mode policies are `allow` rules that only
ever restrict what `right` allows. Attenuation blocks are `check`s. A scope also allows `list`
on its ancestors, so `ls /` shows the delegated branch and nothing else.

### Bundled tools

Tools written for Node (`import { readFile } from "node:fs/promises"`) are bundled with
`@statewalker/webrun-bundler` so that every Node builtin is rewritten at build time. The fs
modules become an inline shim over the tool's `files` capability. This is option (a): one
shim per bundle, with no realm-global registry.

```ts
import * as esbuild from "esbuild"; // or an initialized esbuild-wasm
import { bundleTool } from "./src/tools/bundle.ts";

const { code, hash, check } = await bundleTool({
  esbuild,
  sources: { "/index.ts": `import { readFile } from "node:fs/promises";
    export async function run({ path }) { return (await readFile(path, "utf8")).length; }` },
  entry: "/index.ts",
  config: { /* overrides of tool-bundle.config.json */ },
});
// POST /api/agents/:name/run { …, task: { kind: "tool", code, bundled: true, input: { path: "/proj/a.md" } } }
// `hash` ("sha256-…") is what a deployment lists in allowedBundles to approve this exact bundle.
```

Or from the command line: `pnpm bundle-tool <dir> [--entry /index.ts] [--config overrides.json]
[--out tool.bundle.js]`. It prints the hash on stderr, and exits 1 when the bundle would fail
the Agent's check. Bundling runs wherever esbuild runs (Node, a browser with esbuild-wasm), not
inside the Durable Objects. The generated entry file is removed from the source tree afterwards.

**The tool contract:** the module exports `run(input)` or a default function; a default-exported
class is refused with `EINVAL`. The bundle's entry is a generated `WorkerEntrypoint` whose
`run(files, input)` binds `files` to the shim, then calls the tool.

**The modules a tool gets:**

- **`fs` and `node:fs`:** the async API (`readFile`, `writeFile`, `appendFile`, `readdir` with
  `withFileTypes`, `stat`/`lstat`, `mkdir`, `rm`, `unlink`, `rmdir`, `realpath`, `access`,
  `copyFile`, `cp`, `rename`, `exists`). Each works with a trailing callback or as a promise,
  plus `promises` and `constants`. The sync, stream, fd, link and chmod functions exist but
  throw `ENOSYS`.
- **`fs/promises` and `node:fs/promises`:** the promise functions of the same shim (its default
  export is `fs.promises`).
- **Errors** carry `code`, `errno`, `syscall` and `path`. `access` checks existence only: the
  capability authorizes the actual write when it happens.
- **Data:** the store holds UTF-8 text.
  - `readFile` without an encoding returns a Buffer-like `Uint8Array` with `toString(encoding)`
    (`utf8`, `latin1`, `ascii`, `hex`, `base64`), so `JSON.parse(buf)` works.
  - With an encoding it returns that string.
  - Writing bytes that are not valid UTF-8, or a string with a non-utf8 encoding, is refused
    with `EINVAL` instead of corrupting the file.
- **`path`:** a pure POSIX path (`join`, `resolve` from `/`, `normalize`, `relative`, `parse`,
  `format`, …). `path.win32` throws.
- **`process`:** a frozen stub. `process.env` is `processEnv` (`NODE_ENV=production` by default),
  `cwd()` is `/`, and `nextTick` works. `global` is `globalThis`.
- **Other builtins** (with `builtins: "deny"`): imports link, both default and the builtin's
  own named exports (`import { Buffer } from "node:buffer"`), and any use throws `ENOSYS`. With
  `builtins: "external"`, the imports stay and the check rejects them. A CommonJS
  `require("x")` of a builtin compiles to a call of `undefined` and fails when it runs.

**Configuration:** [`tool-bundle.config.json`](tool-bundle.config.json) holds the defaults.
`bundleTool({config})` and `--config` override them for one bundle. The `TOOL_BUNDLE` var (a
JSON string, or an object in wrangler `vars`) overrides them for what a deployment accepts.
Nothing in a request changes the run side.

| Key | Default | Meaning |
|---|---|---|
| `fsModules` | `node:fs`, `fs`, `node:fs/promises`, `fs/promises` | specifiers that become the fs shim (`…/promises` gets the promise API) |
| `pathModules` | `node:path`, `path`, `node:path/posix`, `path/posix` | specifiers that become the POSIX path |
| `builtins` | `"deny"` | every other Node builtin: `"deny"` or `"external"` (above) |
| `modules` | `{}` | your own module sources by specifier; they win over the rules above |
| `external` | `["cloudflare:workers"]` | imports left in the bundle, and the only imports the check accepts (`*` matches any run of characters) |
| `define` | `process` → stub, `global` → `globalThis`, `require` → `undefined` | free globals replaced at build time |
| `processEnv` | `{ "NODE_ENV": "production" }` | `process.env` of the stub |
| `check.forbidIdentifiers` | `eval`, `Function`, `require`, `process`, `global`, `importScripts` | FREE references the check rejects (locals of the same name are fine), also as `globalThis.x` |
| `check.forbidDynamicImport`, `check.forbidImportMeta` | `true` | reject `import()` and `import.meta` |
| `check.restrictGlobalObject` | `true` | reject any use of `globalThis`/`self`/`global`/`window` other than reading a plain property: aliasing (`const { process: p } = globalThis`), passing it (`Reflect.get(globalThis, …)`), computed access. Turn it off for libraries that test for the global object; forbidden keys stay rejected |
| `hostFsRuntimes` | `"refuse"` | run side, on runtimes whose isolates see the host file system: `"refuse"` every tool, or `"bundled-only"`, meaning approved bundles only |
| `allowedBundles` | `[]` | run side: hashes of approved bundles. When not empty, only these run, on every runtime. `"bundled-only"` needs it |
| `requireBundled` | `false` | run side: every tool must be a bundle that passes the check, even on workerd |

**What runs where (`toolIsolates`):**

| | raw module | bundle that passes the check | approved bundle (hash in `allowedBundles`) |
|---|---|---|---|
| `isolated` (workerd) | runs (refused with `requireBundled`, or when `allowedBundles` is set) | runs (when `allowedBundles` is set: refused) | runs |
| `bundled-only` (cellb, opt-in) | `EPERM` | `EPERM` | runs |
| `refused` (cellb, default) | `EPERM` | `EPERM` | `EPERM` |

**The check is defense in depth, not the gate.** It uses acorn plus eslint-scope, so it sees
free references, not names. It still cannot remove code evaluation through the constructors of
ordinary functions (`({}).constructor.constructor("…")()`, `(async () => {}).constructor`), and a
unit test pins that limit. On workerd this does not matter, because the isolate has no host file
system. On cellb the code would run beside the real `node:fs`. That is why `bundled-only` admits
only bundles a deployment approved by hash, never a client's own bundle. Approve only bundles
you have reviewed: an approved bundle runs with the host access a cellb tool isolate has.
`ALLOW_HOST_FS_TOOLS = "1"` lets every tool run there, for experiments only.

### Python

Python code runs on [Pyodide](https://pyodide.org) (CPython 3.14 compiled to WebAssembly) in an
engine of its own, never in the cell's realm. It works on the same filtered file system:

1. **Before a run**, the Agent copies every file its capability can read under `root` (default
   `/`) into the engine's `/workspace`. Files the capability hides are simply not there.
2. **The code runs** with `/workspace` (or `cwd`) as its working directory: ordinary `open`,
   `os`, `csv`, `json`, `sqlite3` and so on work on that copy. `import capfs` gives live,
   authorized calls (`await capfs.read_text(p)`, `write_text`, `append_text`, `listdir`,
   `exists`, `stat`, `mkdir`, `remove`), with paths in the capability's namespace (a
   `/workspace/…` path is accepted too).
3. **After the run**, the engine reports what changed. The Agent writes it back through the
   capability: each new directory, write and deletion (a removed tree as one recursive delete)
   is authorized again. The result lists what was `written`, `deleted` and `denied` (with the
   error), as well as `stdout`, `stderr`, `value` (the last expression; when it is awaitable, the
   run waits for it) and `error` (the traceback).

```json
{ "workspace": "acme", "token": "…", "transport": "token", "chain": [{ "scope": "/proj" }],
  "task": { "kind": "python", "code": "import csv\nrows = list(csv.reader(open('/workspace/proj/data.csv')))\nlen(rows)" } }
```

| Runtime | Engine | What confines it |
|---|---|---|
| cellb on Node | a child process (`node --permission`) | it may only read Pyodide's directory and the engine script: no writes, no child processes or workers. Code generation from strings is disabled, so Pyodide's FFI cannot reach `Function("…")`. Its environment is empty |
| cellb in a browser | a module Worker (`/python/engine.mjs`) | served with a CSP (`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`), so there is no eval and no other origin. After Pyodide loads, the network and storage APIs (`fetch`, `WebSocket`, `indexedDB`, `navigator.storage`, …) are removed from its global scope |
| workerd (wrangler) | none | `ENOSYS`: no child processes, and workerd does not compile fetched WebAssembly |

In every engine, the `js` module is empty (`jsglobals: {}`). The engine never holds the
capability: it only sends file requests by message, and the Agent answers them with the
capability.

- **One engine per capability:** an agent cell (one per agent name, so callers with different
  rights can share it) keeps its engine only while the same capability (the same revocation id)
  runs. A run with another capability gets a new engine. So nothing one caller left in the
  interpreter is seen by another: files outside `/workspace`, patched builtins, background tasks.
  Within one capability, each run gets fresh globals, the modules and `sys.path` of a fresh
  interpreter, and a fresh `/workspace`. Files elsewhere (`/tmp`) and changes to builtins
  persist only for that same capability. `fresh: true` starts a new engine anyway. Starting an
  engine takes about 2 s.
- **`capfs` calls belong to their run.** Each call carries the id of the run that started the
  calling code: a `contextvars` value, copied into every task that code creates. At the end of
  a run its leftover tasks are cancelled. A call from a task that outlived its run is refused
  (`EACCES`), even while another run is active, and is never answered with another run's
  capability.
- **Limits:**
  - A run that exceeds `timeoutMs` (default 30 s) ends with `ETIMEDOUT`, and its engine is
    replaced.
  - An idle engine stops after 5 minutes.
  - The copy into `/workspace` stops at 5000 files or 16 MB (`synced.truncated`).
  - A run's write-back stops at 5000 files or 16 MB (`truncated`).
  - `stdout` and `stderr` are cut at 1 MB each, and the value at 64 KB. The engine enforces these
    limits, and the Agent checks them again.
  - The store holds UTF-8 text, so binary output is refused (`EINVAL`).

**Configuration** (vars):

- `PYTHON=off` disables Python.
- On Node, `PYTHON_ENGINE` (the path of `src/python/engine.mjs`) and `PYODIDE_INDEX` (Pyodide's
  directory) are required. `scripts/serve-cellb.mjs` sets both.
- In a browser they default to `/python/engine.mjs` and `/pyodide/`.

**Remaining exposure:**

- On Node 22 the permission model does not restrict the network. With `js` empty, Python has no
  JS bridge to it: sockets fail ("Host is unreachable"), and `pyodide.http` loses `fetch` after
  loading. A test asserts both. Node 25 adds `--allow-net` for a hard guarantee.
- In the browser, the engine runs on the page's origin. The removed APIs are the known routes,
  and the CSP blocks eval and other origins.
- **The CSP is the host's job.** `scripts/serve-browser.mjs` sends it with `/python/engine.mjs`;
  any other host that serves the engine must send the same `Content-Security-Policy` header.

### In a browser

`pnpm dev:browser` builds `dist/` and serves the project at <http://127.0.0.1:8790/>:

- **`dist/cellb`** is `cellb build`'s output, which `loadProject` fetches.
- **The cells worker** (`browser/cells-worker.ts`) runs it with SQLite on OPFS (`@sqlite.org/sqlite-wasm`).
- **The page** (`browser/page.ts`) reaches the cells worker over a MessagePort
  (`serveRuntime` / `connectRuntime`) and exposes `window.capfs.api(path, body, { admin })`, the
  same HTTP API the Node runtimes serve.
- **Worker Loader code** runs in cellb's own isolate worker, one Dedicated Worker per isolate.
- **The demo page** runs a Python snippet as alice (rights: `/proj`).

## Examples

Scope a sub-agent to `/proj`, read-only, two hops away:

```json
{ "workspace": "acme", "token": "…", "transport": "token",
  "chain": [{ "scope": "/proj" }, { "readOnly": true }],
  "task": { "kind": "flue", "calls": [{ "tool": "grep", "params": { "pattern": "TODO", "path": "/proj" } }] } }
```

Run a tool that can read `/proj` and nothing else:

```js
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(files, input) {
    files ??= this.env.FILES; // an RpcTarget (stub transport) or a service binding (token transport)
    return files.readdir("/proj"); // files.attenuate(), fetch(): refused
  }
}
```

## Internals

```
src/worker.ts       gateway: routes, admin guard, opens the capability for stub transport
src/workspace.ts    Workspace DO (owner cell): store + Authority; FilteredFiles RpcTarget; fsCall
src/authority.ts    root key, durable sessions/modes/revocations, cached verification, FsGate
src/sql-fs.ts       the store: a file system on ctx.storage.sql
src/policy.ts       method → operation map, modes, authority and attenuation blocks
src/path.ts         normalisation ("/.." is "/"), exact prefixes, error codes in messages
src/caps.ts         holder side: StubCap, TokenCap, ToolFiles (what a tool isolate gets)
src/capfs.ts        just-bash IFileSystem over a capability; /dev/null sink; safeExec
src/agent.ts        Agent DO: bash, Flue tools, Worker Loader tools, delegation chain
src/flue-compat.ts  `rg` shim so Flue's grep tool works on just-bash
src/tools/config.ts  ToolBundleConfig: defaults (tool-bundle.config.json) ← overrides ← TOOL_BUNDLE
src/tools/shims.ts   fs shim over `files`, POSIX path, deny modules, the WorkerEntrypoint wrapper
src/tools/bundle.ts  bundleTool(): webrun-bundler with the shims (build side; not in the Worker)
src/tools/check.ts   acceptance check (acorn + eslint-scope), bundle hash
src/tools/policy.ts  toolPolicy() and admitTool(): what may run here, from the deployment config only
src/python/engine.mjs  the Python engine (Pyodide): a Node child process or a browser Worker
src/python/kernel.ts   Agent side: files into /workspace, live capfs calls, write-back through the capability
src/python/hosts.ts    where the engine runs per runtime (node child with --permission, Worker, none)
browser/               the browser host: page, cells worker (cellb + SQLite on OPFS), index.html
scripts/bundle-tool.mjs    CLI around bundleTool
tests/scenario.test.mjs    the cross-runtime suite (HTTP)
tests/durability.test.mjs  write → restart → check
tests/unit/                the core on node:sqlite; tool bundling, check and policy
tests/fixtures/            the Node-style tool the scenario bundles (approved in cellb-bundled-only)
scripts/run-env.mjs        start runtime, run suites, restart, stop (process group)
scripts/serve-cellb.mjs    cellb on node:http (optionally on a celld bucket; --var overrides vars; sets the Python vars)
scripts/build-browser.mjs  dist/cellb (cellb build) and dist/browser (esbuild)
scripts/serve-browser.mjs  static server for the browser build, Pyodide and the engine (with its CSP)
tests/python-scenario.mjs  the Python cases, shared by tests/python.test.mjs (HTTP) and tests/browser.test.mjs
```

### Results (9 Nov 2026)

| Check | wrangler | cellb | cellb, bundled-only | cellb on celld bucket | celld 0.6.0 |
|---|---|---|---|---|---|
| scenario, stub transport (13) | ✅ 13 | ✅ 12, 1 skipped | ✅ 12, 1 skipped | ✅ 12, 1 skipped | n/a: celld refuses RpcTargets across isolates |
| scenario, token transport (13) | ✅ 13 | ✅ 12, 1 skipped | ✅ 12, 1 skipped | ✅ 12, 1 skipped | ✅ 13 |
| scenario, runtime and admin (2) | ✅ | ✅ | ✅ | ✅ | ✅ |
| durability across a restart | ✅ | ✅ | ✅ | ✅ | ✅ |
| `examples/walkthrough.mjs` | ✅ | ✅ | not run | not run | not run |
| python (13 cases) | `ENOSYS` (as designed) | ✅ 13 | ✅ 13 | ✅ 13 | `ENOSYS` (as on workerd) |

In Chromium on cellb (`test:browser`), 16/16 pass: the runtime check, the capability check
(rights, both transports, Flue tools with delegation), the 13 Python cases, and no page errors.
The Python cases include the review's findings:
- a caller's files, builtins and tasks are not seen by a run with another capability;
- a task that outlives its run cannot use `capfs`;
- there is no network from the engine;
- a removed tree is removed from the store, and oversized output is truncated.

The 27 unit tests (`tests/unit`) need no runtime and pass on Node 22. On cellb, the raw-tool test
asserts the `EPERM` refusal. The bundled-tool test asserts `EPERM` by default; under
`bundled-only` it asserts a run of the approved bundle, `EPERM` for a changed one, and `EPERM`
for the global-object alias. The cross-caller isolate test is skipped there.

**celld** (0.6.0, in Docker) runs the project unchanged with the token transport. celld refuses
to pass RPC stubs between isolates ("RPC stubs cannot cross isolate boundaries yet"), so the
stub transport is not available there, and an RpcTarget cannot be passed into a Worker Loader
isolate either ("could not be cloned"). Tool isolates therefore get their files through the
`env.FILES` service binding. cellb-on-celld-bucket checks the storage half of celld
compatibility (the bucket holds `cells/<Class>:<id>/own.json` and `ltx/e<epoch>/…` objects).

**Known gap, closed by refusal:** on cellb (Node), a Worker Loader isolate runs in a worker
thread that resolves the real `node:fs` and `process`. Such a tool could read the cells' SQLite
files under the data directory, including the Workspace's root secret key in `cap_meta`. With
that key it could mint any token and read every workspace. So the Agent refuses tool tasks on
that runtime by default (`EPERM`, `toolIsolates: "refused"`). On workerd, each isolate sees only
its own virtual `/bundle`, `/tmp` and `/dev`, has no network, and cannot re-delegate; the test
asserts that. `hostFsRuntimes: "bundled-only"` admits bundles that the deployment approved by
hash, so a client cannot bring its own code. An approved bundle still runs beside the real
`node:fs`, so approve only reviewed code (see [Bundled tools](#bundled-tools)). A real fix needs
shim-only isolates in cellb, or yesterday's vm runner.

### Decisions a reader would otherwise undo

- **The store is SQLite in the owner cell.** No caller ever gets it. `FsGate` authorizes every
  entry an operation touches before reaching it: the path, every missing parent a write would
  create, every entry of `rm -r`, and every source and destination entry of `cp -r`/`mv`.
  Subtree queries compare bytes, not `LIKE` (which ignores case in SQLite).
- **`cp`/`mv` semantics are the store's.** "Into an existing directory" is resolved once. Copying
  or moving a tree into itself is `EINVAL`. `mv` onto the same path is a no-op. `stat` returns
  `ino`/`dev`, so just-bash can tell distinct files apart.
- **Session state is read fresh on every call.** A mode switch or a revocation applies on the
  next call of every stub and token already handed out.
- **The session comes from the token's authority block.** The caller does not supply it. A token
  only works in its own session and workspace, and it is verified once per token string (cached).
- **`/..` is `/`, as in POSIX.** Tools such as `rg` walk up to the root. Authorization always
  runs on the normalised path, so clamping grants nothing.
- **`/dev/null` is a sink in `CapFs`, holder-side.** Flue's `glob` and `grep` redirect to it. It
  never reaches the store.
- **The `rg` shim:** Flue 2.3's grep tool runs `grep -rnH`, and just-bash 3.6's grep rejects
  `-H`, so Flue's grep finds nothing on any just-bash file system (`InMemoryFs` included). The
  shim answers Flue's `rg --version` probe and translates the call; it refuses options it does
  not know. Remove it once this is fixed upstream.
- **A denied read looks like a missing file in just-bash.** Commands such as `cat` check
  `exists()` first, and `CapFs.exists()` answers `false` on any error, so the existence of
  files outside the rights is not revealed. Flue's `read`, `write` and `edit`, and the raw
  capability, report `EACCES`. Flue's `grep` and `glob` simply find nothing there.
- **Denied redirects abort the whole `exec()`** (just-bash). `safeExec` fails closed and reports
  them as a failed command. Earlier output in the same script is lost.
- **Tools get `ToolFiles` (stub transport) or a `ToolFilesEntrypoint` binding (token transport),
  never the capability object or the token.** They can use it but not attenuate or hand it off,
  only during the call (a run lease checked with the Agent cell on every binding call), and each
  call gets a new isolate. Two notes on the entrypoint:
  - It is a named export of the Worker. Other Workers of the same Cloudflare account could bind
    to it with props of their own, but without the nonce of a live run it refuses everything.
  - cellb 0.5.2 dispatches any function-valued name of an entrypoint instance, `Object.prototype`
    methods included, so `valueOf()` would return the instance with its props. The entrypoint
    shadows those methods; workerd and celld do not dispatch them at all. An isolate keyed by the code would keep its globals,
  so whatever one user's call read could be returned to the next user.
- **Limits of the prototype:** contents are stored as UTF-8 text (not binary-safe). `readdir`
  and recursive operations run one Datalog authorization per entry, so a large tree, or a
  costly attenuation block, makes `ls -R`/`grep -r` slow for the Workspace cell. A revocation id
  is checked for form only; it cannot be tied to its session without the token.
