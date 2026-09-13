# 02 — Can a Biscuit token be verified inside a ServiceWorker?

`pnpm test 02-sw-access`

**Answer: not with the package as published, and yes through a loader seam
that the package already exposes.** Both variants are real workers in a real
Chromium, registered by `@statewalker/webrun-http-browser`'s
`initServiceWorker`, each asked to verify one token minted by
`httpeers.core`'s own `mintToken`.

**But the architecture means this is an option, not a requirement.** The
shipping worker (`apps/httpeers-stack/src/pages/app/sw.ts`) is *one*
side-effecting import of `webrun-http-browser/sw-worker` and contains no
application code at all: the PAGE registers the handler through
`SwHttpAdapter`, and the worker only dispatches to it. So access checks run
in the page today, where biscuit-wasm already works. This rung establishes
what it would cost to move one into the worker, not that anything must.

## Verified

| # | Claim | How it is established | What would falsify it |
|---|---|---|---|
| 1 | The published build **cannot** be used in a module worker | `sw-naive.ts` imports `verifyToken` normally; registration never yields a controlling worker, and the page reports `stage: "register"` | Registration succeeding — which would mean the constraint was lifted upstream and variant B is unnecessary |
| 2 | Instantiating **from bytes** through `__wbg_set_wasm` verifies a real token in the worker | `sw-manual.ts` calls `initBiscuit(wasmUrl)` then `verifyToken`; the worker returns `{sub, roles}` matching what was minted | Any failure inside the worker — the reply carries the error verbatim |

Measured 2026-09-12, both pass.

## The seam, and its price

`@biscuit-auth/biscuit-wasm`'s entry point does `import * as wasm from
"./biscuit_bg.wasm"`, which a bundler turns into fetch-and-instantiate behind
a **top-level await**. Pages allow top-level await; module ServiceWorkers do
not. What makes the other route possible is that `biscuit_bg.js` exports
`__wbg_set_wasm(exports)` — so the module can be instantiated by hand inside
an async function and the shim armed afterwards.

Two costs the library would inherit, both real:

1. **The deep import is not resolvable.** The package's `exports` map is
   `{ "import": "./module/biscuit.js" }` with no wildcard, so
   `@biscuit-auth/biscuit-wasm/module/biscuit_bg.js` cannot be imported by any
   strict resolver. This rung reaches it by filesystem path, which a prototype
   may do and a published package may not. Shipping it means a documented
   bundler alias, a vendored copy, or an upstream change.
2. **The wasm imports seven generated snippet modules**, not just the binding
   module. Supplying only `./biscuit_bg.js` fails with
   `Import #17 "./snippets/biscuit-auth-314ca57174ae0e6d/inline0.js": module
   is not an object or function`. Their directory names are content hashes, so
   `biscuit-shim.ts` gathers them with `import.meta.glob` rather than naming
   them — which ties the seam to a bundler that supports it.

## The trap this rung walked into, twice-documented now

The first build produced workers that **registered, activated, and did
nothing**: no `fetch` listener, no `clients.claim()`, so the page was never
controlled and `initServiceWorker` waited forever on a `controllerchange` that
could not come. Cause: `@statewalker/webrun-http-browser` declares
`"sideEffects": false`, so the bare `import ".../sw-worker"` that is the
worker's entire job is legally tree-shaken — and this vite version accepts
`rollupOptions` while **silently dropping its `treeshake` field**, so the
`treeshake: false` that prevents it never took effect. The fix is
`rolldownOptions` + `treeshake: false`.

`apps/httpeers-stack/vite.app.config.ts` already carries this warning from its
own Task 12. It cost an hour again here. **Any extracted package that ships a
worker entry has to carry the same note**, and the check is behavioural — a
worker that registers proves nothing; a worker that *controls the page* does.

## Not covered

- **Firefox and Safari.** Chromium only. Module-worker support differs, and
  Safari is not exercised anywhere in this project.
- **Whether verification in the worker is ever wanted.** The page holds the
  libp2p node, so inbound mesh requests are verified in the page. This matters
  only for an edge that enforces policy itself — the ghost's pin (rung 06) is
  the candidate, and it can also be done page-side.
- **Cost.** The wasm is 2.35 MB and is instantiated per worker. Nothing here
  measures start-up latency or memory.
- **`warmUpTokens`.** The first-call time-limit misfire is handled inside
  `verifyToken`; this rung did not isolate it.
