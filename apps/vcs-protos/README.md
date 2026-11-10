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
| `05-runtime-matrix` | X0a — **identical in 4 runtimes; browser BLAKE3 too slow** | Do the X1 primitives behave identically in Chromium (page and worker) and workerd, and how fast are they there? |
| `06-wasm-hash-tier` | X1e — **works everywhere; BLAKE3 16× (Node) to 35× faster; workerd SHA via DigestStream** | Can a WASM hash tier run in every runtime, including workerd, and is it fast enough for browser Xet? |
| `07-lockfile-cas` | X2 — **works on mem, Node, OPFS; native git interop** | Can git's lock-file protocol give a crash-safe, linearizable ref compare-and-set on FilesApi, interoperating with native git? |
| `08-sqlite-kv-cas` | X3a — **works on node:sqlite, sqlite-wasm, workerd DO; one owner per OPFS sahpool pool** | Can a KvStore whose compare-and-set is one SQL statement be linearizable on node:sqlite, sqlite-wasm and a Durable Object? |
| `09-git-objects` | X4 — **git's ids and loose objects on every backend; seam needs `putStaged`, FilesApi must stream writes** | Can one raw-bytes git object kernel over BlobStore give git's ids and git's loose objects on every backend? |
| `10-ref-transactions` | X5 — **atomic ref batches on git files (two-phase packed-refs), SQL and KV; git's rules** | Can one atomic ref-transaction API run on git files, SQL and KV, with git's semantics? |

`pnpm test` runs typecheck and both vitest projects (`node` and `browser`, Chromium); a folder filter applies to both. `pnpm test 01-streaming-git-hash` runs one.
`pnpm bench` prints the throughput tables recorded in each README.

Vendored code is copied verbatim from `statewalker/webrun-vcs@f1abdd3` into each
folder's `src/vendor/` so the prototype tests exactly what ships today.
