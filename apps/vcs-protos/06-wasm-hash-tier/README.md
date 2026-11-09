# 06 — Can a WASM hash tier run in every runtime, including workerd, and is it fast enough for browser Xet?

Plan id **X1e** (part of X1 "PlatformServices"; open thread 1 of X0a). Status: **answered — yes: identical results in all four runtimes; BLAKE3 ~16× faster than noble in Node and 28–35× in Chromium and workerd; workerd needs the modules imported precompiled, and has a faster native SHA-1/SHA-256.**

## Question

X0a measured pure-JS BLAKE3 at 12–13 MB/s in Chromium and 15–17 MB/s in workerd — below the
20 MB/s line X1c set for Xet uploads — so a faster tier is required there. WASM is the only
portable option, but **workerd forbids compiling WebAssembly from bytes at runtime** (a probe:
`WebAssembly.compile(): Wasm code generation disallowed by embedder`), and popular libraries such
as `hash-wasm` compile their embedded binaries from bytes. Can the `hash-wasm` binaries (BLAKE3,
SHA-1, SHA-256) be driven by a small wrapper that takes an already-compiled `WebAssembly.Module` —
compiled from bytes in Node and browsers, imported as a precompiled module in workerd — with
results identical to the references, and how much faster are they than noble in each runtime?

## Reject condition

Rejected if any reference value differs in any runtime, if workerd cannot load the binaries at all,
or if WASM BLAKE3 stays below 20 MB/s in Chromium or workerd.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | The three `.wasm` files committed here are byte-identical to the binaries embedded in `hash-wasm@4.13.0` (provenance test re-extracts and compares). |
| R2 | WASM BLAKE3 matches all 35 official vectors for `hash` and `keyed_hash` at 131-byte output; `derive_key` (not built into these binaries) is rejected with a clear error rather than computing something else. |
| R3 | WASM SHA-1 git object ids equal `git hash-object`; WASM SHA-256 equals `node:crypto`. |
| R4 | Digests are independent of chunking, including chunks larger than the binaries' 16 KiB transfer buffer and splits across it. |
| R5 | Two hashers used at the same time (interleaved updates) produce independent, correct digests. |
| R6 | The same checks pass in a Chromium page and Dedicated Worker (modules compiled from bytes) and in workerd (modules imported precompiled); a passing trap test documents that compiling from bytes fails in workerd. |
| R7 | Throughput of WASM vs noble for BLAKE3, SHA-1 and SHA-256 measured in Node, page, worker and workerd and recorded. |

## Scope — what this prototype does NOT do

- No `clone()` / state save-restore (the binaries support it; not needed to answer the question).
- No building the binaries from source (clang + wasm-ld are available; a reproducible build is a follow-up).
- No Xet chunking or Merkle hashing — only the primitive.
- No CellB/celld, Firefox or WebKit.

## Answer

**Yes.** `hash-wasm`'s BLAKE3, SHA-1 and SHA-256 binaries, driven by a ~100-line wrapper that takes
an already compiled `WebAssembly.Module`, pass every reference check in **Node, a Chromium page, a
Chromium Dedicated Worker and workerd**. In workerd the binaries are imported precompiled
(`CompiledWasm` modules); compiling the same bytes at runtime is refused there with
`Wasm code generation disallowed by embedder`, which is why `hash-wasm` as published cannot run in
workerd at all: it compiles its embedded base64 on first use, from a private module cache.

**BLAKE3 goes from 17–18 MB/s (noble, Chromium and workerd) to 480–630 MB/s (WASM)** — far above the
20 MB/s line X1c set for Xet — and from 30–46 MB/s to 490–690 MB/s in Node. SHA-1 and SHA-256 gain
2–6× in browsers. In workerd, though, the review of #52 pointed to a native tier this prototype had
missed: **`crypto.DigestStream` hashes SHA-1 and SHA-256 at 1.1–1.3 GB/s, 3–4× faster than WASM** —
so WASM is the answer there for BLAKE3 only.

Indicative numbers from one isolated run per project (vitest runs the `node` and `browser` projects
concurrently, which depresses all numbers; these were measured one project at a time), 2026-11-09,
4-core Xeon @ 2.1 GHz; Node v22.23.4 (CI uses Node 24, not benchmarked); Chromium 1243 headless;
workerd via Miniflare 4.20260730.0 (timed from outside, minus a no-op). WASM and DigestStream benches
hash 128 MiB, noble BLAKE3 16 MiB, noble SHA-1/SHA-256 32 MiB; each warmed up first in the same
process, page or worker. MB = 10^6 bytes. Run-to-run variation is up to ~30 % (e.g. Node noble
BLAKE3 measured 30 and 46 MB/s in two runs).

| MB/s | Node | Chromium page | Chromium worker | workerd |
|---|---|---|---|---|
| BLAKE3 WASM | 493 | 634 | 528 | 481 |
| BLAKE3 noble | 30 | 18 | 18 | 17 |
| SHA-1 WASM | 545 | 514 | 523 | 407 |
| SHA-1 noble | 189 | 85 | 90 | 142 |
| SHA-1 native | ~1 450 (`node:crypto`, X1a) | — (no streaming API) | — | **1 070** (`crypto.DigestStream`) |
| SHA-256 WASM | 281 | 182 | 263 | 246 |
| SHA-256 noble | 159 | 62 | 65 | 119 |
| SHA-256 native | ~1 590 (`node:crypto`, X1c) | — (no streaming API) | — | **1 172** (`crypto.DigestStream`) |

Browsers have WebCrypto `subtle.digest`, which is native but one-shot (the whole input in one
buffer), so it cannot hash a stream in bounded memory; that is why WASM is the browser tier.

## Verified

All 9 Node tests (including workerd) and 4 browser tests pass (`pnpm test 06-wasm-hash-tier`). The DigestStream check, the use-after-digest check and the stronger chunking checks followed the review of #52.

| # | Result |
|---|---|
| R1 | Re-extraction from `hash-wasm@4.13.0` equals the three committed `.wasm` files and their base64 copies byte for byte (`src/wasm/provenance.json` records sizes and SHA-256) |
| R2 | 35 official vectors × `hash` (each in **one** update, crossing the 16 KiB transfer buffer for vectors above 16 KiB) and `keyed_hash` (1000-byte updates) at 131-byte output; `derive_key` is rejected by the wrapper with an explicit error; a 31-byte key is rejected |
| R3 | SHA-1 git ids equal `git hash-object` for X0a's five objects, each object in one update (the 300 KiB blob crosses the buffer); SHA-256 equals `node:crypto` |
| R4 | One 256 KiB update, 16383/16384/16385-byte splits and 1/40000-byte splits across the 16 KiB transfer buffer: SHA-256 equals node:crypto's value in the fixture; BLAKE3 and SHA-1 equal noble (their official references are covered by R2/R3 single updates). The check fails if the 256 KiB fixture is missing or resized |
| R5 | Two keyed BLAKE3 hashers with interleaved updates produce independent, correct digests |
| R6 | All 84 checks (including use-after-digest throwing) pass in Node, page, worker and workerd; every runner asserts a literal snapshot of 84 checks in 8 families; trap test: compiling from bytes in workerd is refused; workerd's `crypto.DigestStream` SHA-1/SHA-256 also match git and node:crypto |
| R7 | Throughput table above |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 key ignored at init | R2 keyed checks (Node and workerd) |
| M2 no 16 KiB chunking | R4 and R3 large inputs |
| M3 one instance shared by all hashers of a module | R5 |
| M4 output length ignored at finalisation | R2 (131-byte vectors) |
| M5 `context` silently accepted | the explicit derive_key test and the conformance check (both test the wrapper's guard; the binaries have no derive_key mode) |
| M6 `done` guard removed (added after review: a second `Hash_Final` silently returns a wrong value) | the `finalized` check |

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| "A WASM tier means adding a library such as `hash-wasm`" (X1c/X0a open threads) | `hash-wasm` as published cannot run in workerd (runtime compilation is refused). Its binaries can, through a wrapper that receives the compiled module; how the module is obtained is a per-runtime bundling concern. |
| "Whether WASM loads in workerd is open" | It loads when imported as a module (`CompiledWasm`), and not when compiled from bytes. |
| First decision of this prototype: "WASM for SHA-1/SHA-256 in workerd" | workerd's native `crypto.DigestStream` is 3–4× faster (review of #52); WASM in workerd is for BLAKE3 only. |
| First README: "BLAKE3 15–18 MB/s (noble) in every runtime; 25–40× faster" | 17–18 MB/s holds for Chromium and workerd only; Node noble is 30–46 MB/s, so the gain is ~16× in Node and 28–35× elsewhere. |

## Functional description

`scripts/extract-wasm.ts` pulls the base64 binaries out of `hash-wasm`'s ESM build and writes
`src/wasm/*.wasm`, a base64 module (`binaries.ts`) and `provenance.json`. `createWasmHasher(module,
algo, opts)` instantiates one instance per hasher (each binary holds one hash state), writes the key
into the transfer buffer for keyed BLAKE3, and streams input through the 16 KiB buffer.
`compileModulesFromBytes()` serves Node and browsers; `src/workerd-entry.ts` imports the three
`.wasm` files, which esbuild leaves external and Miniflare loads as `CompiledWasm` modules —
exactly how a Cloudflare Worker bundle ships WASM.

## Interfaces produced

```ts
type WasmAlgo = "blake3" | "sha1" | "sha256";
interface WasmHashOptions { key?: Uint8Array /* 32 bytes */; context?: never /* rejected */; dkLen?: number }
function createWasmHasher(module: WebAssembly.Module, algo: WasmAlgo, opts?: WasmHashOptions): Promise<Hasher>;
function compileModulesFromBytes(): Promise<Record<WasmAlgo, WebAssembly.Module>>; // Node, browsers
// workerd: import blake3 from "./wasm/blake3.wasm" (a WebAssembly.Module)
```

## Decision (reversible)

PlatformServices hash tiers, per runtime, from the measurements above:

| | Node | Browser (page, worker) | workerd |
|---|---|---|---|
| SHA-1, SHA-256 | `node:crypto` | WASM (these binaries) | `crypto.DigestStream` |
| BLAKE3 | WASM | WASM | WASM (imported precompiled) |
| Fallback (no WASM) | noble | noble | noble |

The WASM module is always injected (never compiled inside the library), so each runtime's bundling
decides how it is obtained.

## Licensing

The three binaries are © 2020 Dani Biró, MIT License; the notice travels with them in
`src/wasm/LICENSE.hash-wasm` (verbatim copy, including the third-party credits), and
`provenance.json` records the license. The embedded C implementations carry their own permissive
licenses (BLAKE3 CC0/Apache-2.0, SHA-1 public domain, SHA-256 ISC-style), per hash-wasm's notice.

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `src/wasm-hasher.ts` | **Adopt** | Small, ABI-documented, module-injected; becomes the WASM tier of PlatformServices |
| `scripts/extract-wasm.ts`, `src/wasm/*` | **Source** | Until a reproducible from-source build replaces extraction (open thread 1) |
| `tests/*`, `src/conformance.ts` | **Adopt** | Joins the runtime-matrix harness |

## Open threads (ranked by how much later work they would invalidate)

1. **Reproducible binaries**: build the three `.wasm` files from `hash-wasm`'s C sources with the available clang/wasm-ld and compare, instead of trusting extracted bytes (R1 only proves they equal the published package).
2. **`clone()`/state save-restore** via the binaries' `Hash_GetState`/`STATE_SIZE` is not implemented; X1a/X1c's `Hasher` has `clone()`.
3. **Instance cost**: one instance per hasher (an `instantiate` per object) is fine for large files; for many small objects (git trees, commits) a pool, as in X1d, should be measured.
4. **Xet specifics**: confirm Xet uses keyed BLAKE3 only (no derive_key), which these binaries cover.
5. **Bench method**: run benches outside the concurrent vitest projects (a dedicated bench script per runtime), so numbers are comparable run to run.
6. CellB/celld, Firefox, WebKit not run.
