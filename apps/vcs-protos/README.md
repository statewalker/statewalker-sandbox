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
| `11-sql-blob-store` | X3b — **native chunked SQL BlobStore wins: ≈3× faster on git-sized objects, atomic putStaged** | Should git objects in SQL go through a native chunked BlobStore or through SqliteFilesApi? |
| `12-index-pack` | X6a — **index-pack: `.idx` byte-identical to git's (or git's refusal), quarantine, base-cache-bounded memory** | Can a pure-TS index-pack install real git packs byte-identically, in bounded memory, everywhere? |
| `13-pack-reader` | X6r — **objects read from packs + loose as git cat-file; checkpoint base cache; 64 MiB blob streams** | Can objects be read from installed packs (and loose objects) as native git reads them, in bounded memory, everywhere? |
| `14-thin-packs` | X6b1 — **thin packs completed as git --fix-thin; 200k entries in +19 MiB; one storage read per window; tmp sweep** | Can index-pack complete thin packs from the local repository and index 100k+ objects in a Durable Object's memory? |
| `15-resumable-index` | X6b2 — **index-pack as a resumable job: cold steps, crash at any storage op, DO restarted per step → the one-shot pack and .idx** | Can index-pack run in bounded steps that survive the eviction of a Durable Object? |
| `16-pack-to-sql` | X6b3 — **keep packs as the store of record; exploding to rows is git-identical, crash-safe, DO-resumable, reads text 3–7× faster for 3–34× the bytes** | Should the native SQL store explode received packs into object rows, or keep them as packs? |
| `17-repository` | X16a — **one command layer over git files and one SQL Db: same ids (git's), native-git interop, DO** | Can one repository API run unchanged over git files and over a single SQL database? |
| `18-pack-export` | X6c — **git's object set, packs git accepts from both backends and a DO, streaming, backpressure, cancel; whole objects 3.8× git's size** | Can a repository export the pack git expects, streaming, with backpressure and cancel? |
| `19-delta-reuse` | X6d — **reused entries and deltas: export at 1.05× git's pack (from 3.8×), CRC-checked, cycle-free, thin packs** | Can export reuse what packs already hold — compressed entries and deltas — as git does? |
| `20-delta-search` | X6e — **git's delta search: incremental and loose exports at 0.84–0.99× git's pack, bounded window, big files left alone** | Can export compute new deltas, as git's pack-objects does, to come near git's size where nothing is reusable? |
| `21-smart-http` | X8a — **git's smart protocol v2 over a fetch handler: native git clones, deepens and fetches from ours, ours from `git http-backend`; shallow, gzip, streamed, git's negotiation** | Can git's smart protocol (v2) run over a plain fetch handler, both ways, with native git? |
| `22-receive-pack` | X8b — **git push over the same handler: native `git push` to ours (files, SQL), ours to `git http-backend`; atomic, CAS, connectivity-checked, thin (1.07× git), streamed (+2 MiB for 64 MiB), hooks** | Can git push run over the same fetch handler, both ways, with native git? |
| `23-git-httpeers` | X8c — **git between httpeers peers: X8a/X8b unchanged over the bridge; httpeers' mesh roles, access per service and per ref (`refs/peers/<id>/*`); a push longer than the bridge's head timeout** | Can git run between httpeers peers, authorized per service and per ref by Biscuit tokens? |
| `24-gc` | X18 — **safe gc: native `gc --prune`'s object set at 0.84× its pack; grace by a ledger (no mtimes); re-mark and leases for concurrent writers; resumable; files and SQL** | Can a repository garbage-collect and repack safely — concurrent writers, resumable, on every backend? |
| `25-repo-facade` | X16b — **one façade: `git init --bare` files, git config edited in place, `VcsError` codes, abort ≤ 100 ms with no ref change, reference-transaction and commit hooks, gc leases on writers; DO** | Can one repository façade open every backend, report typed errors, cancel within 100 ms, and run git's hooks? |
| `26-lfs` | X10a — **Git LFS as git-lfs: pointers byte-identical, store in its layout, Batch API + basic transfer both ways with native git-lfs, verified, Range resume, 256 MiB in +17 MiB heap; DO** | Can Git LFS run on our stores, both ways with native git-lfs, verified, resumable, in bounded memory? |

`pnpm test` runs typecheck and both vitest projects (`node` and `browser`, Chromium); a folder filter applies to both. `pnpm test 01-streaming-git-hash` runs one.
`pnpm bench` prints the throughput tables recorded in each README.

Vendored code is copied verbatim from `statewalker/webrun-vcs@f1abdd3` into each
folder's `src/vendor/` so the prototype tests exactly what ships today.
