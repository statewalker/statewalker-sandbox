# kitesurf-cellb

Runs [Kitesurf](https://github.com/cloudflare/kitesurf), Cloudflare's experimental browser engine
for Workers, unchanged on [CellB](https://cellb.dev) in Node, and serves its Chrome DevTools
Protocol endpoint. Puppeteer, chrome-devtools-mcp and other CDP clients can drive it without
workerd, wrangler or a Cloudflare account.

Checked (`pnpm test`): example.com renders with its Latin, Arabic, CJK and Cyrillic text and a
full-size screenshot; React TodoMVC takes typed input and clicks. Hacker News also loads.

## Run

1. Build Kitesurf next to this repository (Bazel and Rust; about 13 minutes on 4 CPUs the first
   time):
   ```sh
   git clone https://github.com/cloudflare/kitesurf ../kitesurf && cd ../kitesurf
   pnpm install --frozen-lockfile
   bazel run //packages/engine:dev_build
   ```
   Where GitHub archive downloads are blocked, Bazel stops at `bats-core`, a test-only toolchain.
   Pass `--override_repository=bazel_lib++toolchains+bats_toolchains=<dir>`, where `<dir>` holds
   `bats@1.10.0` from npm, an empty `REPO.bazel`, and bazel_lib's `BATS_CORE_TEMPLATE` as
   `BUILD.bazel` with `libraries = []`.
2. Set up and start the host, from this directory:
   ```sh
   pnpm install
   node scripts/setup.mjs ../../../kitesurf   # engine/wrangler.json, and /bundle/*.wasm links
   pnpm start                                 # http://127.0.0.1:8787
   ```
3. Drive it: `node smoke.mjs https://example.com/` (title, text, `screenshot.png`), `node
   todomvc.mjs`, or any CDP client at `ws://127.0.0.1:8787/devtools/browser`
   (discovery: `/json/version`).

## How it fits together

| File | What it does |
| --- | --- |
| `server.mjs` | `loadProject("engine")` from `@statewalker/cellb/node`, `node:http` for requests, and a `ws` bridge for CellB's `101` + `webSocket` answers (the CDP socket) |
| `scripts/setup.mjs` | writes `engine/wrangler.json` (Kitesurf's engine config with absolute paths and `nodejs_compat`) and links Kitesurf's wasm into `/bundle` |
| `scripts/patch-cellb.mjs` | made `patches/@statewalker__cellb@0.8.7.patch` at the repository root (pnpm `patchedDependencies`) |
| `polyfills.mjs` | `Uint8Array` base64/hex methods for Node 22, in the main thread |

Kitesurf reads its wasm with `node:fs` from workerd's `/bundle` module directory. With
`nodejs_compat`, CellB gives Worker code the real `node:fs`, so `/bundle` is a real directory
here.

## The CellB patches

CellB 0.8.7 differs from workerd in nine ways that Kitesurf runs into. This app depends on 0.8.7
alone, so the patch changes no other app's CellB.

1. Worker Loader `{ cjs }` modules become `export default undefined`. Kitesurf loads page scripts
   and web workers as cjs.
2. `CompiledWasm` imports use top-level `await WebAssembly.compile`. With Kitesurf's circular
   imports, esbuild's async module inits wait on each other and `loadProject` never settles.
3. The assets router ignores a class default export (`fetch` on its prototype).
4. The runtime's `fetch` ignores a class default export (`export default class extends
   WorkerEntrypoint`): "Worker has no fetch handler".
5. `abortIsolate` is missing from `cloudflare:workers`. Patched to throw; the isolate is not killed.
6. `navigator` is getter-only in Node isolate threads; Worker code may assign it on workerd.
7. `stub.dup()` on a stub that crosses into an isolate becomes a remote call, not a copy.
8. `Request`, `Response`, `Headers` and `ReadableStream` in isolate RPC arguments and results throw
   `DataCloneError`. Patched to cross with buffered bodies.
9. Node 22 has no `Uint8Array.prototype.toBase64` (workerd does); isolate threads get a polyfill.

## Limits

- CellB ignores per-isolate `limits` (CPU, subrequests), so a runaway page script is not stopped,
  and `abortIsolate` does not free an isolate.
- Bodies crossing isolates are buffered, not streamed.
- `global_fetch_strictly_public` is not enforced (`project.unsupported` lists it).
- A page load takes about 18–23 s, mostly a fixed cost per load (worker threads, esbuild bundling
  of page modules); not profiled.
- Node only. A browser tab would also need a CORS proxy for page fetches, and CDP clients outside
  the tab cannot reach its WebSockets.
