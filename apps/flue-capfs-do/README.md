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
- Untrusted tool code runs in a Worker Loader isolate. It has no network, no bindings, and only
  the narrowed capability.

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
| `GET /api/runtime` | any | `{workerLoader, userAgent, bootId}` |

Admin routes need `Authorization: Bearer $ADMIN_KEY` when `ADMIN_KEY` is set (it is set to
`dev-admin-key` in `wrangler.jsonc`). In production, the gateway authenticates the user and reads
their rights from the namespace configuration.

Tasks:

- `{kind: "bash", script, cwd?}` runs a just-bash shell over the capability.
- `{kind: "flue", calls: [{tool, params}], cwd?}` calls Flue's tools as a model would.
- `{kind: "tool", code, input?}` runs a module in a Worker Loader isolate. The module exports
  `default class extends WorkerEntrypoint { run(files, input) }`.
- `{kind: "revocationId"}` returns the revocation id of the capability the agent holds.

`chain: [{scope?, readOnly?, datalog?}, …]` adds one hop per entry. Each hop attenuates the
capability and hands it to a new sub-agent cell (`<name>/sub`, `<name>/sub/sub`, …), and the
last hop runs the task.

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

On each call, the authorizer provides `operation(op)` (`read`, `list` or `write`),
`resource(path + "/")` and `check if session(sid)`, all bound as parameters. The authority
block holds `user`, `session` and `right("/p1/")` facts. Mode policies are `allow` rules that only
ever restrict what `right` allows. Attenuation blocks are `check`s. A scope also allows `list`
on its ancestors, so `ls /` shows the delegated branch and nothing else.

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
tests/scenario.test.mjs    the cross-runtime suite (HTTP)
tests/durability.test.mjs  write → restart → check
tests/unit/                the core on node:sqlite
scripts/run-env.mjs        start runtime, run suites, restart, stop (process group)
scripts/serve-cellb.mjs    cellb on node:http (optionally on a celld bucket)
```

### Results (9 Nov 2026)

| Check | wrangler | cellb | cellb on celld bucket | celld |
|---|---|---|---|---|
| scenario, stub transport (8) | ✅ | ✅ (1 known gap) | ✅ (1 known gap) | not run |
| scenario, token transport (8) | ✅ | ✅ (1 known gap) | ✅ (1 known gap) | not run |
| durability across a restart | ✅ | ✅ | ✅ | not run |
| `examples/walkthrough.mjs` | ✅ | ✅ | not run | not run |

The 8 unit tests (`tests/unit`) need no runtime and pass on Node 22.

celld was not run in the session that built this: its release binary and container image could
not be fetched or run there. cellb-on-celld-bucket checks the storage half of celld
compatibility (the bucket holds `cells/<Class>:<id>/own.json` and `ltx/e<epoch>/…` objects).
Whether celld passes `RpcTarget`s between cells by reference is unverified; if it does not, the
token transport (`TRANSPORTS=token`) is the one to use there.

**Known gap:** on cellb (Node), a Worker Loader isolate runs in a worker thread that resolves the
real `node:fs` and `process`. The tool probe lists the host's `/`, so a tool could bypass the
capability on that runtime. On workerd, the same isolate sees only its own virtual `/bundle`,
`/tmp` and `/dev`, has no network, and cannot re-delegate. The test reports this as a `todo`
on cellb and fails anywhere else. Yesterday's fix still applies: bundle the tool, run the
acceptance check, and use the vm runner; or use shim-only isolates in cellb.

### Decisions a reader would otherwise undo

- **The store is SQLite in the owner cell.** No caller ever gets it. `FsGate` authorizes every
  call before reaching it.
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
  shim answers Flue's `rg --version` probe and translates the call. Remove it once this is fixed
  upstream.
- **A denied read looks like a missing file in just-bash.** Commands such as `cat` check
  `exists()` first, and `CapFs.exists()` answers `false` on any error, so the existence of
  files outside the rights is not revealed. Flue's tools and the raw capability report
  `EACCES`.
- **Denied redirects abort the whole `exec()`** (just-bash). `safeExec` fails closed and reports
  them as a failed command. Earlier output in the same script is lost.
- **Tools get `ToolFiles`, not the capability object.** They can use it but not attenuate or hand
  it off.
