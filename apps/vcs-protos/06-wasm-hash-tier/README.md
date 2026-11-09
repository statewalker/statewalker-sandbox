# 06 — Can a WASM hash tier run in every runtime, including workerd, and is it fast enough for browser Xet?

Plan id **X1e** (part of X1 "PlatformServices"; open thread 1 of X0a). Status: **in progress**.

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
