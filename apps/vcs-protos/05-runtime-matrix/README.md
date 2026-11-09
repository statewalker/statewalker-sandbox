# 05 — Do the X1 primitives behave identically in Chromium (page and worker) and workerd, and how fast are they there?

Plan id **X0a** (first slice of X0 "runtime matrix"). Status: **answered — identical results in all four runtimes; Chromium hashes 2–4× slower than Node, and browser BLAKE3 falls below the Xet threshold.**

## Question

X1a–X1d proved their primitives in Node only, and their READMEs call them "expected to be portable,
unverified until X0". The product is browser-first and must also run in Durable Objects (workerd).
Do the portable modules — single-pass git hashing (01), the push inflater and pack walker (02),
SHA-256 / BLAKE3 / LFS pointers (03) and the pooled inflater (04) — produce **the same results** in a
Chromium page, a Chromium Dedicated Worker and workerd as in Node, from **one** conformance module
fed with fixtures produced by real git in Node? And what throughput do they reach in each runtime?

## Reject condition

Rejected if any conformance check fails in any runtime, or if the portable modules cannot be
bundled for a non-Node target (a `node:` dependency anywhere in their import graph).

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | Fixtures are produced in Node by the real oracles (git hash-object, git pack-objects + verify-pack, git lfs pointer where installed, node:zlib, node:crypto, the official BLAKE3 vectors) and are plain JSON. |
| R2 | One portable `runConformance(fixtures)` runs every check (git ids with two SHA-1 implementations, all BLAKE3 vectors × 3 modes, SHA-256, LFS pointers, a zlib sequence through the push inflater and the pooled inflater at awkward chunk sizes, an OFS and a REF pack walk) and returns a stable, named list. In Node every check passes. |
| R3 | The same checks all pass in a headless **Chromium page** (vitest browser mode, Playwright). |
| R4 | The same checks all pass in a **Chromium Dedicated Worker** started from that page. |
| R5 | The modules bundle with esbuild for `platform: "browser"` with nothing external, the bundle contains no `node:` specifier, and the same checks all pass in **workerd** (Miniflare). |
| R6 | Throughput of SHA-1, SHA-256, BLAKE3 and pooled inflate is measured in Node, page, worker and workerd and recorded. |

## Scope — what this prototype does NOT do

- No CellB, celld or real Cloudflare (later X0 slices); workerd via Miniflare only.
- No Firefox or WebKit; Chromium only (the CI image installs Chromium and Firefox; Firefox is a follow-up).
- No storage, no OPFS, no network — pure computation over fixtures.
- No new primitives: it runs the X1a–X1d modules unchanged.

## Answer

**Yes.** One conformance module — 131 named checks over the four X1 modules, against fixtures made by
real git, git-lfs, node:zlib, node:crypto and the official BLAKE3 vectors — passes **every check in
Node, a Chromium page, a Chromium Dedicated Worker and workerd**. The modules bundle for
`platform: "browser"` with nothing external and no `node:` specifier.

Throughput is the finding that changes plans: hashing in headless Chromium is 2–4× slower than in
Node or workerd, and **BLAKE3 in the browser runs at 12 MB/s — below the 20 MB/s line X1c used to
decide that a WASM tier was optional.** That line was measured in Node only. For browser-side Xet,
a WASM BLAKE3 is required.

Measured 2026-11-09, one run each, 4-core Xeon @ 2.1 GHz; Node v22.23.4; Chromium 1243
(Playwright 1.63, headless); workerd via Miniflare 4.20260730.0 (timed from outside, minus a no-op
request). MB = 10^6 bytes.

| bench | Node | Chromium page | Chromium worker | workerd |
|---|---|---|---|---|
| SHA-1 noble (MB/s) | 200 | 74 | 82 | 165 |
| SHA-256 noble (MB/s) | 128 | 55 | 56 | 92 |
| BLAKE3 noble (MB/s) | 45 | **12** | **12** | 15 |
| inflate, pooled, 5k small objects (objects/s) | 176 433 | 137 741 | 108 225 | 225 693 |

The small-object inflate numbers come from runs of 22–46 ms and are indicative only.

## Verified

All 7 Node tests and 4 browser tests pass (`pnpm test 05-runtime-matrix`, `pnpm test:browser`).

| # | Result |
|---|---|
| R1 | Fixtures from git hash-object, git pack-objects + verify-pack (OFS and REF packs), git lfs pointer (or the spec when git-lfs is absent), node:zlib, node:crypto and the official BLAKE3 file; JSON round-trip is lossless; 131 checks expected |
| R2 | All 131 checks pass in Node |
| R2b | Negative control: tampering one git id, one BLAKE3 vector, one SHA-256, one zlib length and one pack offset fails exactly the 12 checks that depend on them |
| R3 | All 131 pass in a Chromium page (vitest browser mode, fixtures passed with `provide`/`inject`) |
| R4 | All 131 pass in a Chromium Dedicated Worker started from the page |
| R5 | esbuild bundle for `platform: "browser"`: no `node:` specifier; all 131 pass in workerd (Miniflare 4) |
| R6 | Throughput table above |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 conformance records every check as ok | R2b |
| M2 a portable module imports `node:zlib` | R5 — esbuild: `Could not resolve "node:zlib"`, before workerd starts |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| X1c: "noble BLAKE3 runs above the 20 MB/s reject line, so a WASM tier is a strong option, not mandatory" | True in Node (37–45 MB/s); **false in the browser** (12 MB/s in page and worker) and in workerd (15 MB/s). For Xet in browsers and Durable Objects a WASM BLAKE3 is required. |
| My assumption while writing R6: "workerd's clocks do not advance during compute, so time it from outside" | Under Miniflare, workerd's `performance.now()` advances and agrees with the outside clock (288 vs 297 ms in a probe). Frozen timers are documented for production Cloudflare, which was not tested. The outside measurement is kept because it is valid in both. |
| X1a: "noble is 4× faster than the vendored SHA-1" — measured in Node | Still the right default, but absolute browser speed (74–82 MB/s) means a 1 GiB file takes ~13 s to hash in a page. |

## Difficulties and how they were resolved

- **Miniflare 5 vs 4.** The workspace's wrangler pins Miniflare 5.20261104.0-beta, whose constructor takes a
  new nested `workers: [{ config: … }]` schema. Miniflare 4 (npm `latest`, stable `{ modules, script }`
  API) is used instead: smaller surface, larger user base, easy to swap.
- **A one-off browser failure** ("no tests" for the file) appeared once right after an edit and did not
  reproduce in five later runs, including from a cold Vite cache. The browser config now pre-bundles
  `pako` and the three `@noble/hashes` entry points so Vite can never discover them mid-run and reload
  the page.
- **A fixture bug caught by the run itself:** the official BLAKE3 file names the derive-key context
  `context_string`; a type cast mapped it to `undefined` and all 35 derive-key checks failed. Mapped
  explicitly now.

## How it works

`tests/make-fixtures.ts` (Node only) builds the fixtures with the real tools. `src/conformance.ts`
(portable) decodes them with `atob`, runs each check and returns `{ name, ok, detail }` in a stable
order given by `expectedCheckNames(fixtures)`; `runBench(name)` runs one named benchmark. The same
module is driven from four places: directly in Node; in a page by vitest browser mode, with fixtures
passed from a Node `globalSetup` via `provide`/`inject`; in a Dedicated Worker
(`tests/conformance.worker.ts`) by `postMessage`; and in workerd, where `src/workerd-entry.ts` exposes
`POST /conformance` and `GET /bench/<name>` and is bundled by esbuild for `platform: "browser"`.

## Interfaces produced

```ts
interface Check { name: string; ok: boolean; detail?: string }
interface BenchRow { name: string; amount: number; unit: "MB" | "objects"; ms: number }
function expectedCheckNames(fx: Fixtures): string[];
function runConformance(fx: Fixtures): Promise<Check[]>;
function runBench(name: "sha1-noble" | "sha256-noble" | "blake3-noble" | "inflate-pooled"): Promise<BenchRow>;
// workerd: POST /conformance (body: Fixtures) → Check[];  GET /bench/<name> → BenchRow
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/make-fixtures.ts`, `src/conformance.ts`, the three runners | **Adopt** | The runtime-matrix harness of the plan's X0: every later prototype adds its checks here and inherits four runtimes |
| `vitest.browser.config.ts`, `src/workerd-entry.ts` | **Adopt** | The browser and workerd wiring for `@statewalker/test-harness` |

## Open threads (ranked by how much later work they would invalidate)

1. **WASM BLAKE3 (and SHA-1) in browsers and workerd** — required for Xet in browsers per the numbers above; also decides whether WASM loads in workerd at all. Next prototype candidate.
2. **CellB and celld** runtimes are not yet in the matrix (next X0 slice), nor real Cloudflare (frozen timers, CPU limits).
3. **Firefox and WebKit** not run; CI installs Firefox already.
4. **Why Chromium hashes 2–4× slower than Node** on the same V8 was not investigated (headless flags, `--no-sandbox`, vitest's iframe); it matters for every browser number.
