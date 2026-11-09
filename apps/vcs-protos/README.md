# vcs-protos — feasibility prototypes for the webrun-vcs / webrun-sync plan

Each numbered folder answers **one** question from the combined plan
(Drive: `2026-11-09.Webrun-VCS`, note 08). Every folder has a README with the
question, the reject condition and acceptance criteria fixed before any code,
then tests written first (red), then the implementation (green), then findings.

| Folder | Plan id | Question |
|---|---|---|
| `01-streaming-git-hash` | X1a — **works; use noble** | Can the existing streaming SHA-1 compute git object ids in one bounded-memory pass? |
| `02-inflate-stream-ends` | X1b — **works; slower than native** | Can pako's low-level inflater, fed arbitrary chunks, report exactly where each zlib stream ends? |
| `03-sha256-blake3` | X1c — **works; BLAKE3 slow (WASM tier for Xet)** | Can @noble/hashes provide streaming SHA-256 (LFS) and keyed BLAKE3 (Xet) with reference-exact results? |
| `04-pooled-inflater` | X1d — **works: 3.1× on small objects** | Does reusing pako inflate state (JGit `InflaterCache` style) close the small-object gap without losing exactness? |
| `05-runtime-matrix` | X0a | Do the X1 primitives behave identically in Chromium (page and worker) and workerd, and how fast are they there? |

`pnpm test` runs typecheck, the Node tests and the Chromium tests (`pnpm test:browser`). `pnpm test 01-streaming-git-hash` runs one.
`pnpm bench` prints the throughput tables recorded in each README.

Vendored code is copied verbatim from `statewalker/webrun-vcs@f1abdd3` into each
folder's `src/vendor/` so the prototype tests exactly what ships today.
