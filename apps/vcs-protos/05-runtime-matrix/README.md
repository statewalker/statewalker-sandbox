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
Node, a Chromium page, a Chromium Dedicated Worker and workerd**, on byte-identical fixtures (fixed
seed, fixed git dates). The modules bundle for `platform: "browser"` with nothing external and no
`node:` specifier.

Throughput is the finding that changes plans: hashing in headless Chromium is 2–4× slower than in
Node (1.3–1.7× slower than workerd), and **BLAKE3 in the browser runs at 12–13 MB/s — below the
20 MB/s line X1c used to decide that a WASM tier was optional.** That line was measured in Node only.
For browser-side Xet, a WASM BLAKE3 is required.

Indicative numbers from one run each (they vary by up to ~20 % between runs), 2026-11-09, 4-core Xeon
@ 2.1 GHz; Node v22.23.4 (CI uses Node 24, not benchmarked); Chromium 1243 (Playwright 1.63,
headless); workerd via Miniflare 4.20260730.0, timed from outside minus a no-op request. MB = 10^6
bytes. Every runtime is warmed up in the same process, page or worker before the timed run.

| bench | Node | Chromium page | Chromium worker | workerd |
|---|---|---|---|---|
| SHA-1 noble (MB/s) | 175 | 79 | 88 | 134 |
| SHA-256 noble (MB/s) | 150 | 56 | 61 | 78 |
| BLAKE3 noble (MB/s) | 53 | **13** | **12** | 17 |
| inflate, pooled, 5k small objects (objects/s) | 133 046 | 204 082 | 85 179 | 245 590 |

The small-object inflate runs last 20–60 ms, so that row is noise-dominated and only says "fast
everywhere". In workerd the timer inside the worker agreed with the outside clock (e.g. 247 vs 250 ms
for SHA-1, logged by the test); production Cloudflare freezes timers during execution (documented,
not tested), which is why the outside measurement is the one reported.

## Verified

All 20 Node tests and 16 browser tests pass (`pnpm test 05-runtime-matrix` runs both projects).

| # | Result |
|---|---|
| R1 | Fixtures from git hash-object, git pack-objects + verify-pack (OFS and REF packs), git lfs pointer (or the spec when git-lfs is absent), node:zlib, node:crypto and the official BLAKE3 file; lossless JSON; deterministic (same seed ⇒ byte-identical fixtures); 1.3 MB |
| R2 | All 131 checks pass in Node; every runner also asserts a **literal** snapshot of 131 checks across 10 families, independent of the conformance code |
| R2b | Twelve negative controls, one per fixture family (git id; BLAKE3 hash, keyed, derive; SHA-256; LFS pointer; zlib data and length; pack offset, type, size, packed size): each fails exactly its dependent checks |
| R3 | All 131 pass in a Chromium page; the twelve negative controls also run there (R3b) |
| R4 | All 131 pass in a Chromium Dedicated Worker started from the page |
| R5 | esbuild bundle for `platform: "browser"`: no `node:` specifier; all 131 pass in workerd (Miniflare 4) |
| R6 | Throughput table above |

The pack checks compare every entry's offset and packed size with `git verify-pack -v`, and every
non-delta entry's type and size (verify-pack reports deltas with their resolved type and size).

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 conformance records every check as ok | R2b (and R3b in the page) |
| M2 a portable module imports `node:zlib` | R5 — esbuild: `Could not resolve "node:zlib"`, before workerd starts |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| X1c: "noble BLAKE3 runs above the 20 MB/s reject line, so a WASM tier is a strong option, not mandatory" | True in Node (37–53 MB/s); **false in the browser** (12–13 MB/s in page and worker) and in workerd (15–17 MB/s). For Xet in browsers and Durable Objects a WASM BLAKE3 is required. |
| My assumption while writing R6: "workerd's clocks do not advance during compute" | Under Miniflare they do, and agree with the outside clock (logged by the test). Frozen timers are documented for production Cloudflare only. |
| First version of this README: "Chromium hashes 2–4× slower than Node or workerd" | 2–4× slower than Node; only 1.3–1.7× slower than workerd. |
| First version: "identical results in all runtimes" | The first fixtures were random and rebuilt per runner, so runtimes were checked against different inputs. Fixtures are now seeded and deterministic, so every runtime gets the same bytes. |

## Difficulties and how they were resolved

- **Miniflare 5 vs 4.** The workspace's wrangler pins Miniflare 5.20261104.0-beta, whose constructor takes a
  new nested `workers: [{ config: … }]` schema. Miniflare 4 (npm `latest`, stable `{ modules, script }`
  API) is used instead: smaller surface, larger user base, easy to swap. Cost: the lockfile now holds two
  miniflare/workerd pairs (about 100 MB of workerd binary each in the store), and Miniflare 4 pulls in
  `sharp`. Moving to Miniflare 5's API later removes the duplicate.
- **A one-off browser failure** ("no tests" for the file) appeared once right after an edit and did not
  reproduce in five later runs, including from a cold Vite cache. The browser project pre-bundles `pako`
  and the three `@noble/hashes` entry points so Vite cannot discover them mid-run and reload the page.
- **Fixture bugs caught by the run itself:** the official BLAKE3 file names the derive-key context
  `context_string` (a cast mapped it to `undefined`; all 35 derive-key checks failed), and the git
  repository shared a directory with the LFS oracle files, so `git add -A` committed a 256 KiB random
  file into the pack fixtures (the payload test caught it: 2.0 MB, now 1.3 MB).

## How it works

`tests/make-fixtures.ts` (Node only) builds the fixtures with the real tools from a fixed seed and
fixed git dates. `src/conformance.ts` (portable) decodes them with `atob`, runs each check and
returns `{ name, ok, detail }` (with the seed in every failure) in the order given by
`expectedCheckNames(fixtures)`; `runBench(name)` runs one named benchmark. One vitest config holds two
projects — `node` and `browser` — so a folder filter applies to both. The same module is driven from
four places: directly in Node; in a page, with fixtures passed from a Node `globalSetup` via
`provide`/`inject`; in a Dedicated Worker (`tests/conformance.worker.ts`) by `postMessage`; and in
workerd, where `src/workerd-entry.ts` exposes `POST /conformance` and `GET /bench/<name>` and is bundled
by esbuild for `platform: "browser"`.

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
| `tests/expected.ts`, `tests/tamper.ts`, the three runners | **Adopt** | Snapshot, per-family negative controls and runners become the X0 harness's contract |
| `tests/make-fixtures.ts`, `src/conformance.ts` | **Guideline** | Right idea, wrong shape for a shared harness: one central file imports every prototype (see open thread 2) |
| `vitest.config.ts` projects, `src/workerd-entry.ts` | **Adopt** | The browser and workerd wiring for `@statewalker/test-harness` |

## Open threads (ranked by how much later work they would invalidate)

1. **WASM BLAKE3 (and SHA-1) in browsers and workerd** — required for Xet in browsers per the numbers above; also decides whether WASM loads in workerd at all. Next prototype candidate.
2. **Harness shape for adoption** (from the review of #51): today `conformance.ts` imports every prototype folder and the browser `globalSetup` builds 05's fixtures for any browser test. The shared `@statewalker/test-harness` should let each module export `{ makeFixtures, checks }` and compose them, as its own package rather than `../../0x` imports. Deferred deliberately: that is the design of the harness package itself.
3. **CellB and celld** runtimes are not yet in the matrix (next X0 slice), nor real Cloudflare (frozen timers, CPU limits).
4. **Firefox and WebKit** not run; CI installs Firefox already.
5. **Why Chromium hashes 2–4× slower than Node** on the same V8 was not investigated (headless flags, `--no-sandbox`, vitest's iframe); it matters for every browser number.
