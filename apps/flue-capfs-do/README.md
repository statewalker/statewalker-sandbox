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
| `test:cellb` | `@statewalker/cellb` 0.8.1 `loadProject`, cells in `node:sqlite` files |
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
| `GET /api/w/:ws/sessions/:sid` | admin | `{session, user, mode, revokedAll, revokedIds, model: {allowed, turnsLeft, tokensLeft, used}}` |
| `POST /api/w/:ws/sessions` `{user, rights, mode, model?}` | admin | mints a session token → `{session, token}`; `model`: `false` (default), `true` or a budget `{turns?, tokens?}` (see [Agent loop](#agent-loop)) |
| `POST /api/w/:ws/sessions/:sid/mode` `{mode}` | admin | `yolo` · `prototyping` · `plan` · `readonly` |
| `POST /api/w/:ws/sessions/:sid/revoke` `{rid?}` | admin | revokes one capability (and its descendants), or the whole session |
| `POST /api/w/:ws/sessions/:sid/model` `{turns?, tokens?}` | admin | sets what is left of the session's model budget (each field given is set, `null` = unlimited; others kept) |
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
- `{kind: "bundle", sources, entry, config?}` bundles a tool's Node-style sources in the
  deployment's bundler Worker and returns `{hash, check, bytes, code}` (see [Bundling in the deployment](#bundling-in-the-deployment)).
- `{kind: "tool", sources, entry, config?, input?}` bundles in the deployment, then runs the result
  as a bundle.
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
- `{kind: "agent", prompt, instructions?, maxTurns?, timeoutMs?, session?, cwd?}` runs an LLM
  agent whose tools are Flue's (read, write, edit, grep, glob, bash) over the capability (see
  [Agent loop](#agent-loop)).
- `{kind: "wasmer", script, packages?, cwd?, env?, timeoutMs?}` runs a bash script in a Wasmer
  sandbox whose `/workspace` is the capability (see [Wasmer](#wasmer)); `{kind: "agent", …,
  sandbox: "wasmer"}` runs Flue's tools on such a sandbox.
- `{kind: "revocationId"}` returns the revocation id of the capability the agent holds.

`chain: [{scope?, readOnly?, noModel?, datalog?, llmToken?}, …]` adds one hop per entry. Each hop attenuates the
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
`right("/p1/")` facts, and `model_use(true)` when the session may drive the model: the `agent`
task asks for operation `model` on resource `/`, allowed in every mode by that fact only (the
mode rules name their file operations). Every check of the token must hold for that pair:
`readOnly` and the built-in scopes allow it, `noModel` (`check if operation($o), $o != "model"`)
does not, and a hand-written check keeps or drops it depending on whether `operation("model")`
with `resource("/")` passes it (`!$p.starts_with("/proj/secret/")` keeps it,
`$p.starts_with("/proj/")` drops it). The owner reads the session from the authority block and applies THAT
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
the Agent's check. The generated entry file is removed from the source tree afterwards.
Bundling runs wherever esbuild runs: Node, a browser with esbuild-wasm, or the deployment's
bundler Worker (next section).

#### Bundling in the deployment

The deployment can bundle too: `{kind: "bundle", sources, entry, config?}` returns the bundle,
and `{kind: "tool", sources, entry, config?, input}` bundles and runs it. Both use the same
`bundleTool`, with esbuild-wasm, in a **bundler Worker** that the Agent loads on demand.

```bash
curl -s -X POST localhost:8787/api/agents/a1/run -H 'content-type: application/json' -d '{
  "workspace": "acme", "token": "<token>", "transport": "token",
  "task": { "kind": "bundle", "entry": "/index.ts",
            "sources": { "/index.ts": "import { readdir } from \"node:fs/promises\";\nexport default (i) => readdir(i.dir);" } } }'
# → {"value":{"result":{"hash":"sha256-…","check":{"ok":true,"problems":[]},"bytes":…,"code":"…"}}}
```

- **The bundler Worker** (`src/bundler/program.ts`) is built by `pnpm build:bundler` into
  `src/bundler/program.gen.js` (generated, not committed; the test runners, `dev:*`, `deploy`
  and the browser build run it, so a deploy never ships a stale bundler). The main Worker embeds its code (about 280 KB) but not
  `esbuild.wasm` (about 14 MB). The Agent fetches that once per isolate from the deployment's
  **`BUNDLER_WASM_URL`**, checks it against the SHA-256 pinned at build, and loads both into a
  Worker Loader isolate of their own (no bindings, no outbound network), which it keeps between
  calls. Builds run one at a time per Agent isolate. A call that fails other than by its request,
  or takes over 60 s, retires that isolate; a retired isolate cannot be stopped from here (the
  Worker Loader has no terminate) and runs until its runtime ends it, so after 3 retirements an
  Agent isolate stops offering bundling (`EAGAIN`) until it restarts. The wasm fetch has a 30 s
  timeout and a 32 MB cap; the URL must allow CORS for a browser host.
- **Opt-in:** without `BUNDLER_WASM_URL` the tasks answer `ENOSYS`, and `/api/runtime` reports
  `bundler: false`. No cell compiles esbuild unless a tool is bundled, and the deploy stays the
  size it was. Point the URL at the file in `node_modules/esbuild-wasm/esbuild.wasm` served by
  the deployment (or a CDN copy of that exact version: the hash decides).
- **On cellb's Node host** the bundler isolate is a worker thread that sees the host's files and
  network, as tool isolates do there (`globalOutbound: null` is not a sandbox on that host). The
  bundler is trusted code that only parses its input (no `eval`, no code from a request runs), so
  untrusted sources meet esbuild's and acorn's parsers, not the host; the risk left is a bug in
  those parsers.
- **Why not a second script behind a service binding:** cellb binds services only to its own
  script's entrypoints, so that would not run on cellb. The Worker Loader is on every runtime
  here (workerd, cellb in Node and in a browser, celld), and keeps esbuild's memory and crashes
  out of the Agent cell.
- **Same bundle as on a build machine:** esbuild-wasm and esbuild are the same version (pinned),
  and the bundler is built with Node's builtin export names (those of the Node that ran
  `build:bundler`: a tool importing `* as` a denied builtin hashes the same only on the same Node
  major), so its bundle has the same hash as `bundleTool` on Node; a hash approved in `allowedBundles` admits both (the scenario suite
  checks this, and on `cellb-bundled-only` runs the deployment's bundle under the approved hash).
- **Nothing is trusted more for being built here:** the result is a bundle like any other, so
  the Agent runs the acceptance check and the deployment's policy on it; where no tool may run
  (`refused`, `none`) the tool task is refused before bundling. A caller may set build-side keys
  only (`fsModules`, `pathModules`, `builtins`, `modules`, `define`, `processEnv`, each checked
  for its shape); `external`, the check and the policy are the deployment's. The bundler runs no
  code it is given: sources are parsed and transformed.
- **Limits:** 100 files and 256 KB of UTF-8 sources and config together (esbuild-wasm needs
  about 100 MB for its first build and more for large inputs), a bundle of at most 2 MB.

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

### Agent loop

The `agent` task runs a model loop on the capability: the loop Flue itself is built on
(`@earendil-works/pi-agent-core`, with `pi-ai` for the model call) and Flue's own model-facing
tools (`createReadTool`, `createWriteTool`, `createEditTool`, `createGrepTool`, `createGlobTool`,
`createBashTool`) over the same just-bash sandbox the `flue` task uses. Each file access the
model asks for is a capability call, authorized per entry in the Workspace cell, so a model
holding a `/proj` read-only capability can neither read `/private` nor write anywhere,
whatever it is told.

```bash
curl -s -X POST localhost:8787/api/agents/a1/run -H 'content-type: application/json' -d '{
  "workspace": "acme", "token": "<token>", "transport": "token",
  "task": { "kind": "agent", "prompt": "Summarise /proj/notes.md", "maxTurns": 6, "session": "s1" } }'
# → {"value":{"reply":"…","stopReason":"stop","turns":2,
#             "toolCalls":[{"tool":"read","arguments":{"path":"/proj/notes.md"},"isError":false,"result":"…"}],
#             "usage":{"input":…,"output":…},"session":{"name":"s1","messages":4}}}
```

- **The model is the deployment's.** The `LLM` var names the endpoint
  (`{"baseUrl", "model", "api"?, "contextWindow"?, "maxTokens"?, "headers"?}`, as JSON);
  `api` is `openai-completions` (default, any OpenAI-compatible server), `openai-responses` or
  `anthropic-messages`. The `LLM_API_KEY` secret is its key. Nothing in a request chooses the
  endpoint or sees the key; `/api/runtime` reports `llm: {model, api, host}` (or `null`, and
  the task fails with `ENOSYS`).
- **The model is a right, and a session has a budget.** A session token carries the model
  right only if the admin asked for it (`model: true`, or a budget `{turns?, tokens?}`); without
  it the task fails with `EACCES`, and a hop can take it away (`noModel`). The Workspace cell
  decides, as it decides file access, so modes, attenuation and revocation (also mid-run, at the
  next turn) apply.
  - Before each model request the Agent reserves a turn in the Workspace cell: the right is
    checked again (a revocation stops the next request) and a turn is taken from the budget; with
    no turn or no token left the request is not made and the run ends (`stopReason: "limit"`).
    The cell answers one call at a time, so concurrent runs cannot share the last turn. After the
    request its tokens are charged: input (cached and cache-written prompt tokens included) and
    output, as the provider reports them; a request can go past the token budget by its own size
    (and each concurrent run by one request: turns are exact, tokens are known only afterwards).
    Usage is recorded even when the right is gone by then.
  - A spent budget refuses the next run (`EACCES`) until the admin sets it again
    (`POST …/sessions/:sid/model`: the fields given are set, `null` for unlimited, the others
    kept; only for a session with the right).
  - Runs on a caller's own token are charged too, unless the deployment sets
    `"callerTokenUnmetered": true` in `LLM` and the token is the API key: a token is any string
    until the provider refuses it, and an endpoint that authenticates otherwise would take it.
  - The result carries `budget: {turnsLeft, tokensLeft}` (null: unlimited) for a charged run.
  - **Migration:** tokens issued before the model right have no `model_use`, so the `agent`
    task refuses them; a budget cannot add the right (it is a fact of the token), so mint a new
    session with `model`. Stores get the new session columns on their first start.
- **Callers can bring their own model credential.** Send it in the `x-llm-token` header of
  `/api/agents/:name/run`. Each hop of the `chain` hands it down to the next, and the last hop's
  `agent` task uses it for its model calls. A hop can replace it from there on with `llmToken`
  in its chain entry, e.g. `"chain": [{"scope": "/proj", "llmToken": "<team key>"}]`; an
  entry with only `llmToken` passes the capability on unchanged. Chain tokens travel in the
  request body, so unlike the header they are not kept out of body logs.
  - What the deployment accepts is `callerToken` in `LLM`: `"allow"` (default), `"require"`
    (no run without a caller token, so callers spend their own budget) or `"forbid"`.
  - By default the token replaces the deployment's key (sent as the provider's API key); the
    deployment's static `headers` still go with it. An Anthropic OAuth token (`sk-ant-oat…`) is
    refused there, since pi-ai would switch to another client's mode for it.
  - With `"callerTokenHeader": "x-user-token"` it goes in that header and the deployment's key
    stays the API key: for a gateway that authenticates each caller and holds the provider key.
    Then `require` only makes the header present; the gateway must check it. The header cannot
    be an auth or transport header (`authorization`, `x-api-key`, `content-*`, `anthropic-*`,
    …) or one of the deployment's `headers`.
  - The token is never stored (not in sessions, which do not depend on it either), never
    returned by this code, and never reaches the tools or the model; errors are redacted (the
    deployment's key too). An endpoint that echoes a credential in a successful reply is the
    deployment's to fix. A token is 8 to 4096 characters of `A-Z a-z 0-9 . _ ~ + / = : -`, so it
    cannot break a header or hide in an escaped error.
  - The endpoint should not redirect: a cross-origin redirect may drop `Authorization` but keep
    other headers, such as a `callerTokenHeader`.
  - `/api/runtime` reports `llm.callerToken`, whether a `callerTokenHeader` is set, and
    `callerTokenUnmetered`.
- **Limits:** `maxTurns` (default 12, at most 50) and `timeoutMs` (default 120 s, at most
  600 s; a tool that ignores the abort gets 5 s more, then the run returns, its calls without
  a result marked as errors; such a tool can still finish after the run returned, and its
  session stays locked until it does). A run cut short
  returns `stopReason: "limit"` and the reason in `error`; a run that ends on its last allowed
  turn is not cut short. `prompt` and `instructions` are at most 100 000 characters each.
- **Sessions:** with `session`, the conversation is kept in the cell that runs it (the last
  hop's), and continued next time. Its key is the capability the request brought (its
  revocation id) and, with a `chain`, a digest of the chain: the same token through the same
  chain continues it, while another token or another chain starts its own. The token the last
  hop holds cannot be the key, since attenuation mints fresh block keys on every run. The
  messages hold file contents read with that capability, which is why another capability never
  sees them.
  - A stored history keeps at most 200 messages and 1 MB of UTF-8 JSON, and what is sent back
    each turn stays within `contextWindow` (about 3 characters a token, less `maxTokens`). It
    is trimmed to start with a user message and without aborted or failed replies, so a provider
    accepts it.
  - A cell keeps at most 32 sessions and drops the least recently used one beyond that, whoever
    owns it: a holder can push other capabilities' sessions out of a cell (losing their
    history, not leaking it). Runs on the same session wait for each other; the wait does not
    count against `timeoutMs`.
- **The result** is the last reply, each tool call with its arguments and (clipped) result
  (paired by call id), and token usage. Replies and tool results are clipped at 4000
  characters, a provider error at 500.
- **Tests** use a fake OpenAI-compatible server (`tests/helpers/fake-llm.mjs`) whose replies
  are driven by the prompt (`READ <path>`, `WRITE <path> <text>`, `BASH <script>`, `LOOP`,
  `HISTORY`), so the cases (`tests/agent-scenario.mjs`) check what the tools did, not what a
  model chose to say. `run-env.mjs` passes it to every runtime as `LLM` with a dummy key.
- **Known exposure:**
  - A session with `model: true` has no budget: give sessions a budget, or `callerToken:
    "require"` so callers pay with their own token. Budgets are per session, not per user or
    deployment, and there is no rate limit.
  - The key is a secret only on workerd (`wrangler secret put LLM_API_KEY`). On cellb, `--var`
    makes it a plain var, and in the browser build it would be in `dist/cellb/wrangler.json`,
    which the page loads: anyone who can load the page can read it. The tests pass a dummy key
    there; a browser deployment needs a proxy that adds the key instead.
- **Bundle size:** the loop and the three model APIs add about 2.5 MB to the Worker
  (7.4 MB, 1.25 MB gzipped, in `wrangler deploy --dry-run`).
- **In the browser**, pi-ai probes `node:fs`/`node:os`/`node:path` while it loads whenever
  `process.versions.node` is set, and cellb's browser `process` reports Node 22.
  `src/node-probe-guard.ts`, the entry's first import, hides that field while the modules load
  (only when `process.platform` is `"browser"`).

### Wasmer

The `wasmer` task runs a bash script in a [Wasmer](https://wasmer.io) sandbox (WASIX: real bash,
coreutils, grep, ripgrep and find from the Wasmer registry) whose **`/workspace` is the
capability**. Nothing is copied in or out: every file operation the guest makes (stat, readDir,
open, read, write, mkdir, rename, …) is forwarded to the Agent cell and answered with the
capability, so the Workspace cell authorizes each entry as it does for the other tasks.

```bash
curl -s -X POST localhost:8788/api/agents/a1/run -H 'content-type: application/json' -d '{
  "workspace": "acme", "token": "<token>", "transport": "token",
  "task": { "kind": "wasmer", "script": "cd /workspace/proj && rg -n TODO . && echo done > out.txt" } }'
# → {"value":{"result":{"exitCode":0,"reason":"exited","stdout":"./readme.md:2:TODO …","stderr":"","truncated":false}}}
```

`{kind: "agent", prompt, sandbox: "wasmer"}` gives Flue's tools such a sandbox instead of
just-bash: `bash`, `grep` (ripgrep) and `glob` (find) run in Wasmer, and `read`, `write` and
`edit` call the same capability; paths are then under `/workspace`.

**How the files get there.** The SDK (`@wasmer/sdk`) has an experimental `storageHost(mount)`: an
embedder filesystem as the sandbox's `/workspace`, called synchronously through a bridge
(protocol: wasmer-js `js/bindgen/src/host_filesystem.rs`). It is not in the SDK's public
options, so the engine (`src/wasmer/engine.mjs`) builds each sandbox through the core builder
with the run's id as the mount id; `src/wasmer/host-fs.ts` answers the protocol with the
capability. Open files are buffered (one buffer per path, shared by its handles) and saved on
flush or close. WASIX drops what close returns, so nothing may fail there silently: creating or
truncating a file is written through at open, the write right on an existing file is asked at the
first write (WASIX opens files read-write even to read them), and content that is not UTF-8 is
refused at the write that makes it so. One case cannot be: a write may end inside a character
(the next write may complete it), so a file left with an incomplete last character fails to save
at close and keeps its previous content; a length that would cut a character is refused.

| Runtime | Engine | How file operations reach the Agent cell |
|---|---|---|
| cellb on Node | a child process (`src/wasmer/engine.mjs`) | the engine's file thread (`node-fs-thread.mjs`) writes each request on a pipe and blocks on the reply pipe; `node-preload.mjs` installs the SDK's bridge in its worker threads |
| cellb in a browser | a module Worker started by the cells worker | the SDK's blocking bridge messages, answered in place (SharedArrayBuffer): the page must be cross-origin isolated (`serve-browser` sends COOP/COEP) |
| workerd, celld | none (`ENOSYS`) | Wasmer needs threads and shared memory |

- **Packages** come from the Wasmer registry, limited to `WASMER_PACKAGES` (JSON array or comma
  list; default `wasmer/bash`, `wasmer/coreutils`, `wasmer/grep`, `wasmer/ripgrep`,
  `wasmer/findutils`; bash is always included); a run asking for another is refused (`EPERM`).
  The engine loads them once when it starts, and from then on has **no `fetch`**: the sandbox
  ships a built-in `wasmer` command that would otherwise resolve any registry package with the
  host's fetch (in the SDK's worker threads, which never have one: `node-preload.mjs` on Node, a
  wrapper module around the SDK's worker in browsers). On Node they are cached in `WASMER_CACHE`
  (`serve-cellb` uses `.wasmer-cache/`); a browser caches them per origin. The Node engine
  inherits only the proxy settings (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, …) and runs under
  Node's permission model: it may read files, write only the cache, start worker threads, and
  not start processes.
- **Isolation:** each run is a sandbox of its own (nothing outside `/workspace` survives it), with
  no network. A guest reaches only its mounts: unlike tool isolates on cellb's Node host, a WASI
  guest cannot reach the host's files. When a run ends its mount is dropped and late calls are
  refused.
- **Engine life:** one engine per Agent cell, started at the first run and stopped after 5
  minutes without an open sandbox. A file operation the capability has not answered in 20 s
  fails (on Node one request is served at a time for every sandbox, so none may hold the
  others); a command the engine fails to stop in time restarts the engine; sessions of a
  stopped engine fail at once. Sandboxes are built one at a time, each bound to its run's mount,
  and a sandbox whose open timed out is closed when it is built.
- **Limits:** 60 s per command by default (at most 300 s), 1 MB of output, 256 open files and
  16 MB per file read or written through an open file. The store keeps UTF-8 text (NUL bytes
  included), so binary writes are refused (`ENOTSUP`); symlinks are not in the protocol. A directory listing is one
  capability call (`readdirStat`: the entries the token may list, each with its stat), and its
  reply must fit the SDK's 512 KiB bridge buffer (several thousand entries).
- **Config:** `WASMER=off` disables it; `WASMER_ENGINE` is the engine's path (Node) or URL
  (browser, default `/wasmer/engine.mjs`); `WASMER_SDK` the SDK's URL in a browser (default
  `/wasmer/sdk/dist/index.js`). `/api/runtime` reports `wasmer`: `node`, `browser`, or why not.
- **Metadata cache:** each sandbox caches stats, "no such file" and directory listings (a
  listing answers its entries' stats). The kernel clears it before every command, so changes
  made between commands (a Flue tool's write, another agent's) are seen by the next one; within
  a command entries live 2 s, and the run's own writes, renames and removals forget what they
  change. Changes others make during a command (a Flue tool call running in parallel), and a
  revocation, may show in names and sizes up to 2 s late; contents are always read and written
  through the capability, and an open that may create a file always asks it. Refusals are not
  cached, nor answers that arrive after a change. On typical shell work this cuts capability calls 3–20×
  (`ls -la` of 33 entries: 121 → 6; `wc -l` over 30 files: 293 → 37).
- **Cost of the prototype:** file contents and writes are still one round trip each to the
  Agent cell (and a capability check), which suits shell work; package installs that write
  thousands of files stay slow. `storageHost` is experimental in the SDK and may change.

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
src/agent-loop.ts   the `agent` task: pi-agent-core loop, Flue's tools over the capability, sessions
src/agent-history.ts  how a session history is trimmed (unit-tested)
src/llm-config.ts   the LLM var and one run's credentials (deployment key or caller token)
src/node-probe-guard.ts  hides process.versions.node from pi-ai's load-time probes in the browser
src/tools/config.ts  ToolBundleConfig: defaults (tool-bundle.config.json) ← overrides ← TOOL_BUNDLE
src/tools/shims.ts   fs shim over `files`, POSIX path, deny modules, the WorkerEntrypoint wrapper
src/tools/bundle.ts  bundleTool(): webrun-bundler with the shims (build side and the bundler Worker; not in the main Worker)
src/tools/check.ts   acceptance check (acorn + eslint-scope), bundle hash
src/tools/bundle-request.ts   what a caller may send to be bundled (limits, build-side keys)
src/tools/bundler-client.ts  the Agent's side: fetch and pin esbuild.wasm, load the bundler Worker
src/bundler/program.ts       the bundler Worker: bundleTool with esbuild-wasm (pnpm build:bundler)
src/tools/policy.ts  toolPolicy() and admitTool(): what may run here, from the deployment config only
src/python/engine.mjs  the Python engine (Pyodide): a Node child process or a browser Worker
src/python/kernel.ts   Agent side: files into /workspace, live capfs calls, write-back through the capability
src/python/hosts.ts    where the engine runs per runtime (node child with --permission, Worker, none)
src/wasmer/engine.mjs  the Wasmer engine: sandboxes with /workspace = the capability (Node child or Worker)
src/wasmer/kernel.ts   Agent side: starts the engine, answers its file operations with the run's capability
src/wasmer/host-fs.ts  the SDK's host-filesystem protocol over a capability
src/wasmer/flue-sandbox.ts  a Flue sandbox on Wasmer (agent task, sandbox: "wasmer")
tests/wasmer-scenario.mjs   the Wasmer cases, shared by tests/wasmer.test.mjs (HTTP) and tests/browser.test.mjs
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
tests/agent-scenario.mjs   the agent cases, shared by tests/agent.test.mjs (HTTP) and tests/browser.test.mjs
tests/helpers/fake-llm.mjs a fake OpenAI-compatible streaming server for the agent cases
tests/python-scenario.mjs  the Python cases, shared by tests/python.test.mjs (HTTP) and tests/browser.test.mjs
```

### Results (10 Nov 2026; the celld 0.6.0 column from 9 Nov)

| Check | wrangler | cellb | cellb, bundled-only | cellb on celld bucket | celld 0.6.0 |
|---|---|---|---|---|---|
| scenario, stub transport (16, 10 Nov) | ✅ 16 | ✅ 13, 3 skipped | ✅ 13, 3 skipped | ✅ 13, 3 skipped | n/a: celld refuses RpcTargets across isolates |
| scenario, token transport (16, 10 Nov) | ✅ 16 | ✅ 13, 3 skipped | ✅ 13, 3 skipped | ✅ 13, 3 skipped | ✅ 16 |
| scenario, runtime and admin (2) | ✅ | ✅ | ✅ | ✅ | ✅ |
| durability across a restart | ✅ | ✅ | ✅ | ✅ | ✅ |
| `examples/walkthrough.mjs` | ✅ | ✅ | not run | not run | not run |
| python (13 cases) | `ENOSYS` (as designed) | ✅ 13 | ✅ 13 | ✅ 13 | `ENOSYS` (as on workerd) |
| agent (22 cases, fake model; 10 Nov) | ✅ 22 | ✅ 22 | ✅ 22 | ✅ 22 | ✅ 17 (token transport) |

In Chromium on cellb (`test:browser`), 38/38 pass (10 Nov: the agent task, model tokens, the model right, and a tool bundled by the bundler Worker in a browser isolate; 16 before): the runtime check, the capability check
(rights, both transports, Flue tools with delegation), the 13 Python cases, the 21 agent cases, and no page errors.
The Python cases include the review's findings:
- a caller's files, builtins and tasks are not seen by a run with another capability;
- a task that outlives its run cannot use `capfs`;
- there is no network from the engine;
- a removed tree is removed from the store, and oversized output is truncated.

The 42 unit tests (`tests/unit`) need no runtime and pass on Node 22. On cellb, the raw-tool test
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
  call gets a new isolate. An isolate keyed by the code would keep its globals, so whatever one
  user's call read could be returned to the next user. Two notes on the entrypoint:
  - It is a named export of the Worker. Other Workers of the same Cloudflare account could bind
    to it with props of their own, but without the nonce of a live run it refuses everything.
  - cellb (seen in 0.5.2; kept for later versions) dispatches any function-valued name of an entrypoint instance, `Object.prototype`
    methods included, so `valueOf()` would return the instance with its props. The entrypoint
    shadows those methods; workerd and celld do not dispatch them at all.
- **Limits of the prototype:** contents are stored as UTF-8 text (not binary-safe). `readdir`
  and recursive operations run one Datalog authorization per entry, so a large tree, or a
  costly attenuation block, makes `ls -R`/`grep -r` slow for the Workspace cell. A revocation id
  is checked for form only; it cannot be tied to its session without the token.
