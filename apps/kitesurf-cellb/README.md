# kitesurf-cellb

Runs [Kitesurf](https://github.com/cloudflare/kitesurf), Cloudflare's experimental browser engine
for Workers, unchanged on [CellB](https://cellb.dev) 0.8.9 in Node, and serves its Chrome DevTools
Protocol endpoint. Puppeteer, chrome-devtools-mcp and other CDP clients can drive it without
workerd, wrangler or a Cloudflare account.

Checked (`pnpm test`): example.com renders with its Latin, Arabic, CJK and Cyrillic text and a
full-size screenshot; React TodoMVC takes typed input and clicks. Hacker News and Vue TodoMVC also
load. A page load takes about 2.3–3.3 s.

It also runs inside a browser tab ([browser/](#in-a-browser-tab)).

CellB 0.8.9 has what Kitesurf needs of workerd (statewalker/cellb.dev#138): a class as the default
export, synchronous wasm imports, workerd's `/bundle` in `node:fs`, Worker Loader CommonJS modules,
`import()` resolved against a loaded Worker's modules, `abortIsolate()`, `stub.dup()`, Request and
Response values across isolates, writable isolate globals. Earlier versions needed a local patch.

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
   node scripts/setup.mjs ../../../kitesurf   # writes engine/wrangler.json
   pnpm start                                 # http://127.0.0.1:8787
   ```
3. Drive it: `node smoke.mjs https://example.com/` (title, text, `screenshot.png`), `node
   todomvc.mjs`, or any CDP client at `ws://127.0.0.1:8787/devtools/browser`
   (discovery: `/json/version`).

## How it fits together

| File | What it does |
| --- | --- |
| `server.mjs` | `loadProject("engine")` from `@statewalker/cellb/node`, `node:http` for requests, and a `ws` bridge for CellB's `101` + `webSocket` answers (the CDP socket) |
| `scripts/setup.mjs` | writes `engine/wrangler.json`: Kitesurf's engine config with absolute paths and `nodejs_compat` |

Kitesurf reads its wasm with `node:fs` from workerd's `/bundle` module directory. Under
`nodejs_compat`, CellB serves `/bundle` from the bundle's own wasm modules.

## In a browser tab

`browser/` runs the same engine in a Dedicated Worker of a page: `cellb build` makes a browser
folder of it, `loadProject` from `@statewalker/cellb/browser` loads it, and the page drives it
over CDP through a `MessagePort` to the engine's `/devtools/browser` socket. Kitesurf's own page
isolates are Dedicated Workers too. The pages it fetches are cross-origin, so the host worker sends
them through the server's CORS proxy (`serve.mjs`, `/proxy`).

It is an npm folder of its own, outside the workspace.

```sh
cd browser
npm install
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

- CellB ignores per-isolate `limits` (CPU, subrequests), so a runaway page script is not stopped.
- `global_fetch_strictly_public` is not enforced (`project.unsupported` lists it).
