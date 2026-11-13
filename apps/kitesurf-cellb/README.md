# kitesurf-cellb

Runs [Kitesurf](https://github.com/cloudflare/kitesurf), Cloudflare's experimental browser engine
for Workers, unchanged on [CellB](https://cellb.dev) in Node, and serves its Chrome DevTools
Protocol endpoint. Puppeteer, chrome-devtools-mcp and other CDP clients can drive it without
workerd, wrangler or a Cloudflare account.

Checked (`pnpm test`): example.com renders with its Latin, Arabic, CJK and Cyrillic text and a
full-size screenshot; React TodoMVC takes typed input and clicks. Hacker News also loads.

It also runs inside a browser tab ([browser/](#in-a-browser-tab)), with CellB fixed upstream.

## Two CellB states

- **This app as it is: CellB 0.8.7 plus a local patch** (below). Node only, about 20 s per page
  load.
- **CellB with the fixes upstream** (statewalker/cellb.dev, branch `ccr-5aa5c6fe-j28pma`, not yet
  released): Kitesurf runs with none of this app's workarounds (no patch, no polyfill, no real
  `/bundle`), in Node at about 2.3–3.3 s per page load, and in a browser tab. Once a release has
  them, depend on it and drop `patches/`, `polyfills.mjs` and the `/bundle` step of `setup.mjs`.

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

## In a browser tab

`browser/` runs the same engine in a Dedicated Worker of a page: `cellb build` makes a browser
folder of it, `loadProject` from `@statewalker/cellb/browser` loads it, and the page drives it
over CDP through a `MessagePort` to the engine's `/devtools/browser` socket. Kitesurf's own page
isolates are Dedicated Workers too. The pages it fetches are cross-origin, so the host worker sends
them through the server's CORS proxy (`serve.mjs`, `/proxy`).

It needs the unreleased CellB (above), so it is not a workspace package, and its `package.json` does
not declare `@statewalker/cellb` (an npm install would fetch a release without the fixes): install
a build of the branch into it, which also provides the `cellb` command `build:engine` runs.

```sh
cd browser
npm install
npm install --no-save <path to a `pnpm pack` of cellb.dev/packages/cellb on that branch>
npm run build:engine   # cellb build ../engine --out public/kitesurf (run scripts/setup.mjs first)
npm run build          # vite build of the page and its workers
node serve.mjs 8800 &  # static files, and the CORS proxy at /proxy
node run.mjs https://example.com/
```

Checked in Chromium: example.com, Hacker News, and React and Vue TodoMVC render (screenshots, title
and text), the engine loads in about 2 s and a navigation takes 1.5–2.3 s.

What a tab adds: a CORS proxy for the pages Kitesurf fetches (the browser drops `Set-Cookie`, and
forbidden request headers such as `User-Agent` never reach the proxy); CDP clients outside the tab
cannot reach the engine's socket (the page holds it); an `import()` in code Kitesurf builds with
`Function` resolves against the isolate worker's URL, not Kitesurf's modules (Node resolves it).

## Limits

- CellB ignores per-isolate `limits` (CPU, subrequests), so a runaway page script is not stopped,
  and `abortIsolate` does not free an isolate.
- Bodies crossing isolates are buffered, not streamed.
- `global_fetch_strictly_public` is not enforced (`project.unsupported` lists it).
- With the patched 0.8.7, a page load takes about 18–23 s, mostly CellB re-encoding Kitesurf's
  27 MB wasm as base64 module text for every page isolate (fixed upstream: compiled once, passed
  compiled).
