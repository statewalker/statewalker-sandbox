# @statewalker/webrun-platform

> Prototype, private. One package holding the webrun apps as Durable Object applications.

## What it is

Five apps, each a set of Durable Objects with a `wrangler.jsonc`, composed into one Worker. The
same build runs on Wrangler (workerd, as on Cloudflare), celld 0.6.3, cellb in Node, and cellb in
a browser tab:

| App | Routes | Durable Object | Built on |
|---|---|---|---|
| Package store | `/registry/<name>` | `PackageRegistry`, one per package | a caching proxy of the npm registry |
| ESM CDN | `/npm/<browser\|node>/<name>[@range][/sub]` | `ModuleHost`, one per profile | `@statewalker/webrun-modules` |
| User code as ESM | `/p/<project>/…` | `Project`, one per project | `@statewalker/webrun-modules` |
| Bundler | `/builds`, `/b/<build>/…` | `BuildJob`, one per build | `@statewalker/webrun-bundler` on esbuild-wasm |
| Notebooks | `/nb/<site>/…` | `NotebookSite`, one per site | `@statewalker/notebook-build`, `@statewalker/notebook-site` |

- **The package store** backs every other app. It caches each npm packument for 10 minutes and
  each tarball forever, in the object's SQLite. The other apps reach it through webrun-modules'
  `npmRegistrySource({ fetch })`, and the Node runner reaches it over HTTP.
- **The ESM CDN** serves npm packages as ESM. A range redirects to a pinned URL, and pinned URLs
  are immutable. `?graph` lists every module an entry needs; `?meta` lists a package's files. CSS
  goes through Lightning CSS.
- **User code as ESM** serves a project's files as ESM. A project is files with entry points. A
  snapshot is the hash of the tree, so a snapshot's transformed modules never go stale. TS, TSX,
  JSX and CommonJS are transformed one module at a time, CSS is served as `?module`, and bare
  imports bind to the CDN's pinned URLs at the project's `package.json` ranges.
- **The bundler** turns a project into one package. The input is a ZIP, JSON, or a project
  snapshot. The output is a `no_bundle` wrangler project (`wrangler.json`, `worker.js` with its
  source map, `assets/`, D1 migrations), as files, as `project.zip`, and as a Worker Loader
  payload (`loader.json`). Small builds run in the object. Large ones wait for the Node runner
  (`bin/webrun-build.ts`), which uses the same `buildProject`.
- **Notebooks** compiles Markdown notebooks and Observable Notebook Kit HTML documents to pages
  inside the object. A page's npm imports come from the site's module server.

## Why it exists

The plan was to turn three webrun functions into Durable Object apps that run on every host the
statewalker stack targets: the ESM CDN, user code as ESM, and the bundler. This package is that
prototype, in one place, with demos that prove it on small apps and on EmDash.

## How to use it

Node 22.23 or later, and pnpm, from the sandbox root (`pnpm install`).

```sh
cd apps/webrun-platform
npm run build                     # dist/platform/workerd (Wrangler, celld) and dist/platform/cellb
npx wrangler dev                  # the sources, on workerd
npx wrangler dev -c dist/platform/workerd/wrangler.json
scripts/get-celld.sh && (cd dist/platform/workerd && celld dev .)   # celld bundles with esbuild: put node_modules/.bin on PATH
node scripts/serve-cellb.mjs dist/platform/cellb --port 8793        # cellb in Node
npm run build:browser && python3 -m http.server -d dist/browser 8080 # cellb in a tab: open /__cellb/
```

Then, against any of them:

```sh
curl -L localhost:8787/npm/browser/react                         # the ESM CDN
curl 'localhost:8787/npm/browser/react-dom@19/client?graph'
(cd examples/react-page && zip -r - .) | curl -X POST --data-binary @- localhost:8787/p/demo/import
curl -X POST localhost:8787/p/demo/snapshots                     # → { base }: open <base>~/index.html
(cd examples/hello-worker && zip -r - .) | curl -X POST --data-binary @- localhost:8787/builds
curl -o build.zip localhost:8787/b/<id>/project.zip              # unzip; wrangler dev / celld dev / cellb
npx tsx bin/webrun-build.ts --runner http://localhost:8787       # the Node tier, for queued builds
```

## Examples

### What is checked, and where

`scripts/e2e.ts [wrangler|celld|cellb|all]` starts the platform on each host and checks:

- the CDN, on a small graph (react-dom) and a large one (Observable Plot with d3);
- `examples/react-page` (TSX, CSS, React from the CDN) served as ESM and rendered in Chromium;
- `examples/hello-worker` (Hono, a Durable Object, assets) built in the object and run on the
  same host;
- the same project built by the Node runner.

`scripts/e2e-browser.ts` checks the platform in a Chromium tab on cellb: CDN, project page,
bundler (esbuild-wasm in the tab) and notebooks, all served by the tab.

`demos/` has whole apps; see [demos/README.md](demos/README.md):

- Astro (SSR, a React island, a Durable Object);
- EmDash (Astro CMS: D1, KV, R2, cron);
- notebooks (Markdown and Observable Notebook Kit).

Each demo is built and run on every host.

### Results on this prototype

| | Wrangler | celld | cellb Node | cellb in Chromium |
|---|---|---|---|---|
| ESM CDN (react-dom, Observable Plot) | yes | yes | yes | yes |
| User code as ESM (React page renders) | yes | yes | yes | yes |
| Bundler in the object (hello-worker) | yes | yes | yes | yes |
| Built Worker runs on the host | yes | yes | yes | n/a |
| Bundler on the Node runner | yes | yes | yes | n/a |
| Astro demo: bundled, SSR, Durable Object, island | yes | yes | yes | n/a |
| EmDash: bundled (runner), setup seeds D1, pages | yes | yes | yes | n/a |
| EmDash bundled inside the object (38.5 MB input) | 29 s | 10 s with `CELLD_V8_HEAP_LIMIT_MB=2048` | 16 s | n/a |
| Notebooks compiled in the object, cells run | yes | yes | yes | yes |

## Internals

### One build per host

`scripts/build.mjs` bundles an entry (`src/entries/platform.ts`, `cdn.ts` or `bundler.ts`) twice:

- `dist/<name>/workerd/` keeps the `.wasm` imports as WebAssembly modules next to `worker.js`
  (`no_bundle`). workerd and celld forbid compiling WebAssembly from bytes at run time.
- `dist/<name>/cellb/` compiles the WebAssembly from bytes embedded in the bundle, because cellb's
  project bundler has no `.wasm` loader.

Both alias `cjs-module-lexer` to its pure-JS build: its ESM build compiles inline WebAssembly,
which workerd refuses.

The entry hands the WebAssembly modules to `src/core/wasm.ts`:

- esbuild-wasm is initialized with `{ wasmModule, worker: false }`;
- lightningcss-wasm is initialized before webrun-modules calls its `init()`, so it never fetches
  a `.wasm` by URL.

### Storage

`src/core/sql-files.ts` is a FilesApi on the object's `ctx.storage.sql`:

- blocks of at most 256 KiB, to stay under Cloudflare's 2 MB value limit;
- range queries, not `LIKE`, because workerd limits LIKE pattern length;
- one table prefix per FilesApi.

Every app keeps its files there: packuments and tarballs, transformed modules, project snapshots,
build inputs and outputs, notebook sources and pages.

### One build that runs everywhere

`src/bundler/build.ts` bundles `main` with webrun-bundler:

- conditions `workerd, worker, browser`;
- `cloudflare:*` and `node:*` left to the runtime;
- with nodejs_compat, the bare Node built-in names too.

It also makes the output portable across hosts:

- **KV namespaces without an `id`** (Astro's adapter adds `SESSION` so) get a stable one. celld
  requires it.
- **`node:module`** is replaced by a shim whose `createRequire` falls back to a `require` of the
  common built-ins. celld 0.6.3 throws "not implemented" from `createRequire`, which EmDash calls
  at module initialization.
- **A host-compatibility entry** (`src/bundler/compat.ts`) wraps the default handler. It patches
  the D1 bindings so that a table-valued pragma on celld's internal tables (`_litestream_lock`)
  answers no rows instead of "not authorized". Kysely's SQLite introspector reads every table
  `sqlite_master` lists, so EmDash's migrations fail on celld without it.

### Placement of builds

- A build whose inputs exceed `IN_OBJECT_BUILD_MAX_BYTES` (8 MB), or one asked with
  `tier=runner`, is queued.
- `bin/webrun-build.ts --runner <origin>` claims it (`POST /builds/claim`), downloads the inputs,
  builds with native esbuild, and uploads the output.
- A Cloudflare isolate has 128 MB, and EmDash's build needs far more. The EmDash row of the
  results table shows the in-object build works on hosts without that limit.
- ZIP downloads are streamed one file at a time. celld's isolate heap (about 430 MB by default)
  cannot hold a 38 MB archive and its files together.

### Size

The workerd folders, gzipped:

- the composed platform: 8.1 MB, under Cloudflare's 10 MB limit for paid plans;
- `src/entries/cdn.ts` (no esbuild): 4.4 MB;
- `src/entries/bundler.ts` (no lightningcss): 4.2 MB.

Build each with its config in `deploy/`.

## What will surprise you

- **The apps call each other through Durable Object stubs within one script.** cellb and celld
  support no service bindings to other scripts. Split deployments (`deploy/*.jsonc`) contain
  every object they use.
- **celld's isolate heap is the limit for large builds there.** Raise it with
  `CELLD_V8_HEAP_LIMIT_MB`, or leave them to the runner.
- **Chromium needs the proxy where outbound HTTPS has one.** The pages fetch from
  registry.npmjs.org; `scripts/e2e-browser.ts` passes `HTTPS_PROXY` to Chromium.
- **`sourcemap` is on by default.** EmDash's `worker.js.map` is larger than the worker. Pass
  `?sourcemap=0` to skip it.
- **Projects share the CDN's modules but not its `default` export analysis.** A project's
  `~deps` proxy for a CDN URL emits `default` only when the importer asks for it (a
  webrun-modules `cdn` binding).

## Reference

| Script | What it does |
|---|---|
| `npm run build` | `scripts/build.mjs`: dist/platform/{workerd,cellb} |
| `npm run build:browser` | `scripts/build-browser.mjs`: dist/browser, the platform in a tab on cellb |
| `scripts/e2e.ts [host\|all]` | the platform's checks on Wrangler, celld, cellb |
| `scripts/e2e-browser.ts` | the platform in Chromium on cellb |
| `scripts/serve-cellb.mjs <dir>` | a wrangler project on cellb in Node over HTTP |
| `scripts/hosts.mjs` | start/stop a project on any host (used by the e2e scripts) |
| `scripts/get-celld.sh` | downloads celld 0.6.3 to ~/.cache/celld |
| `bin/webrun-build.ts` | the bundler's Node tier: a local build, or `--runner <origin>` |

| Variable | Default | Meaning |
|---|---|---|
| `PACKUMENT_TTL_S` | 600 | how long a packument is fresh |
| `REGISTRY_URL` | registry.npmjs.org | the upstream registry |
| `IN_OBJECT_BUILD_MAX_BYTES` | 8000000 | larger builds go to the Node runner |
