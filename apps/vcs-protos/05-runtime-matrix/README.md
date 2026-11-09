# 05 — Do the X1 primitives behave identically in Chromium (page and worker) and workerd, and how fast are they there?

Plan id **X0a** (first slice of X0 "runtime matrix"). Status: **in progress**.

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
