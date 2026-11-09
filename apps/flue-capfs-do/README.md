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
- Untrusted tool code runs in a fresh Worker Loader isolate for each call. It has no network,
  no bindings, and only the narrowed capability. On runtimes whose isolates can see the host's
  files (cellb on Node), tool tasks are refused.

## How to run it

```sh
pnpm install                                        # at the repository root
pnpm --filter @statewalker/flue-capfs-do test       # unit + cellb + cellb(celld bucket) + wrangler
pnpm --filter @statewalker/flue-capfs-do test:celld # needs the celld binary (see below)
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
| `test:cellb-bundled-only` | cellb with `TOOL_BUNDLE={"hostFsRuntimes":"bundled-only"}`: checked tool bundles run, raw tools are refused |
| `test:cellb-celld-bucket` | cellb with `celldBucket(sqliteObjectStore(...))`: cells as celld writes them (LTX logs, `own.json` ownership records), in the object store `celld dev` keeps |
| `test:celld` | `celld dev --listen 127.0.0.1:<port>`. Set `CELLD_BIN` (default `celld` on PATH). `CELLD_ARGS` replaces the arguments, with `{port}` substituted. `TRANSPORTS=token` skips the stub transport |

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
| `GET /api/runtime` | any | `{workerLoader, toolIsolates, requireBundled, userAgent, bootId}`; `toolIsolates` is `isolated`, `bundled-only`, `refused` or `none` |

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
  `default class extends WorkerEntrypoint { run(files, input) }`. With `bundled: true` the code
  is a bundle from `bundleTool` (see [Bundled tools](#bundled-tools)), and the Agent runs the
  acceptance check before loading it. Whether a raw module or a bundle may run depends on
  `toolIsolates` (below).
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

const { code, check } = await bundleTool({
  esbuild,
  sources: { "/index.ts": `import { readFile } from "node:fs/promises";
    export async function run({ path }) { return (await readFile(path, "utf8")).length; }` },
  entry: "/index.ts",
  config: { /* overrides of tool-bundle.config.json */ },
});
// POST /api/agents/:name/run { …, task: { kind: "tool", code, bundled: true, input: { path: "/proj/a.md" } } }
```

Or from the command line: `pnpm bundle-tool <dir> [--entry /index.ts] [--config overrides.json]
[--out tool.bundle.js]`. It exits 1 when the bundle would fail the Agent's check.

The tool module exports `run(input)` or a default function. The bundle's entry is a generated
`WorkerEntrypoint` whose `run(files, input)` binds `files` to the shim and calls it. The shim
implements the async `node:fs` API: `readFile`, `writeFile`, `appendFile`, `readdir` (with
`withFileTypes`), `stat`, `mkdir`, `rm`, `unlink`, `rmdir`, `access`, `copyFile`, `cp` and
`rename`. Each works with a trailing callback or as a promise, and `promises` holds the same
functions. The `*Sync` and stream functions throw `ENOSYS`. Errors carry `code` (`EACCES`,
`ENOENT`, …).

**Configuration:** [`tool-bundle.config.json`](tool-bundle.config.json) holds the defaults.
`bundleTool({config})` and `--config` override them for one bundle, and the `TOOL_BUNDLE` var (a
JSON string) overrides them for what a deployment accepts.

| Key | Default | Meaning |
|---|---|---|
| `fsModules` | `node:fs`, `fs`, `node:fs/promises`, `fs/promises` | specifiers that become the capability shim (one shared instance) |
| `pathModules` | `node:path`, `path`, `node:path/posix`, `path/posix` | specifiers that become a pure POSIX `path` |
| `builtins` | `"deny"` | every other Node builtin: `"deny"` (importing works, any use throws `ENOSYS`) or `"external"` (left as an import, so the check rejects it unless it is listed in `external`) |
| `modules` | `{}` | your own module sources by specifier; they win over the rules above |
| `external` | `["cloudflare:workers"]` | imports left in the bundle, and the only imports the check accepts |
| `define` | `process`, `require`, `global` → `undefined` | free globals replaced at build time |
| `check.forbidIdentifiers` | `eval`, `Function`, `require`, `process`, `global`, `importScripts` | free references the check rejects (also as `globalThis.x`; any computed `globalThis[…]` is rejected) |
| `check.forbidDynamicImport`, `check.forbidImportMeta` | `true` | reject `import()` and `import.meta` |
| `hostFsRuntimes` | `"refuse"` | run side, on runtimes whose isolates see the host file system: `"refuse"` every tool, or `"bundled-only"` |
| `requireBundled` | `false` | run side: every tool must be a bundle that passes the check, even on workerd |

**What runs where (`toolIsolates`):**

| | raw module | checked bundle |
|---|---|---|
| `isolated` (workerd) | runs (`requireBundled: true` refuses it) | runs |
| `bundled-only` (cellb with `hostFsRuntimes: "bundled-only"`) | `EPERM` | runs |
| `refused` (cellb, default) | `EPERM` | `EPERM` |

The check is static, so it is **not a sandbox**. Computed property access on ordinary objects
(`({}).constructor.constructor("…")()`) passes it, and a unit test pins that limit. On workerd
this does not matter, because the isolate has no host file system. On cellb, `bundled-only`
still runs the code in a worker thread with the real `node:fs`, so use it for trusted or
reviewed tools only. `ALLOW_HOST_FS_TOOLS = "1"` lets every tool run there, for experiments.

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
src/tools/check.ts   acceptance check (acorn), run by the Agent before loading a bundle
scripts/bundle-tool.mjs    CLI around bundleTool
tests/scenario.test.mjs    the cross-runtime suite (HTTP)
tests/durability.test.mjs  write → restart → check
tests/unit/                the core on node:sqlite
scripts/run-env.mjs        start runtime, run suites, restart, stop (process group)
scripts/serve-cellb.mjs    cellb on node:http (optionally on a celld bucket; --var overrides vars)
```

### Results (9 Nov 2026)

| Check | wrangler | cellb | cellb, bundled-only | cellb on celld bucket | celld |
|---|---|---|---|---|---|
| scenario, stub transport (13) | ✅ 13 | ✅ 12, 1 skipped | ✅ 12, 1 skipped | ✅ 12, 1 skipped | not run |
| scenario, token transport (13) | ✅ 13 | ✅ 12, 1 skipped | ✅ 12, 1 skipped | ✅ 12, 1 skipped | not run |
| scenario, runtime and admin (2) | ✅ | ✅ | ✅ | ✅ | not run |
| durability across a restart | ✅ | ✅ | ✅ | ✅ | not run |
| `examples/walkthrough.mjs` | ✅ | ✅ | not run | not run | not run |

The 20 unit tests (`tests/unit`) need no runtime and pass on Node 22. On cellb, the raw-tool test
asserts the `EPERM` refusal, the bundled-tool test asserts `EPERM` (default) or a run
(`bundled-only`), and the cross-caller isolate test is skipped because raw tools are refused.

celld was not run in the session that built this: its release binary and container image could
not be fetched or run there. cellb-on-celld-bucket checks the storage half of celld
compatibility (the bucket holds `cells/<Class>:<id>/own.json` and `ltx/e<epoch>/…` objects).
Whether celld passes `RpcTarget`s between cells by reference is unverified; if it does not, the
token transport (`TRANSPORTS=token`) is the one to use there.

**Known gap, closed by refusal:** on cellb (Node), a Worker Loader isolate runs in a worker
thread that resolves the real `node:fs` and `process`. Such a tool could read the cells' SQLite
files under the data directory, including the Workspace's root secret key in `cap_meta`. With
that key it could mint any token and read every workspace. So the Agent refuses tool tasks on
that runtime by default (`EPERM`, `toolIsolates: "refused"`). On workerd, each isolate sees only
its own virtual `/bundle`, `/tmp` and `/dev`, has no network, and cannot re-delegate; the test
asserts that. `hostFsRuntimes: "bundled-only"` admits checked bundles on cellb. That narrows the
routes, but it is not a sandbox (see [Bundled tools](#bundled-tools)). A real fix still needs
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
- **Tools get `ToolFiles`, not the capability object.** They can use it but not attenuate or hand
  it off, and each call gets a new isolate. An isolate keyed by the code would keep its globals,
  so whatever one user's call read could be returned to the next user.
- **Limits of the prototype:** contents are stored as UTF-8 text (not binary-safe). `readdir`
  and recursive operations run one Datalog authorization per entry, so a large tree, or a
  costly attenuation block, makes `ls -R`/`grep -r` slow for the Workspace cell. A revocation id
  is checked for form only; it cannot be tied to its session without the token.
