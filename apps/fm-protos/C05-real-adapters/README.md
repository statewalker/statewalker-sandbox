# C05-real-adapters — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C05-real-adapters/`._

---

<!-- source: 01-C05 rung record and code.md -->

# C0.5 — Real adapters · rung record

_9 September 2026 · green: 184 passed, 1 skipped (185) · 11 new · mutations killed: 4/4_

## Verdict

**Mem was not lying.** Every core behaviour asserted against `MemFilesApi`
holds against a real filesystem, unchanged — no assertion had to be weakened,
no adapter special case appeared. Promotion grade: **Adopt**.

That is the good outcome, and it was not guaranteed: this rung existed
precisely because three behaviours were asserted but never observed.

## Adapter

`@statewalker/webrun-files-node@0.7.0` (`NodeFilesApi`, `fs/promises` over a
`rootDir`), against real temp directories created and destroyed per test. OPFS
and File System Access remain browser-only and are checked at D2; a real
**filesystem** adapter is enough to answer the questions this rung asks, since
what mem was hiding is kernel behaviour, not browser behaviour.

## The three unobserved behaviours

**1. Partial target removal after a genuinely interrupted write.** The source
iterable yields one chunk and then throws mid-stream, so the target file really
exists half-written on disk when the exception lands. The engine removes it:
`/dst/f002.txt` is gone, `/dst/f001.txt` survives. Mem could not prove this,
because a mem write is atomic in practice.

**2. Re-acquisition failure on resume.** A storage whose factory throws
(`permission revoked`) fails its own job with that reason in `job.error`, and
the lane stays usable — the next job on the same target completes.

**3. Lane serialisation under real I/O latency.** Two jobs to the same target
storage produce `start:one, end:one, start:two, end:two` with real disk
latency between them, not just with mem's synchronous-ish timing.

Plus a real end-to-end resume: a 12-file copy cancelled mid-flight, then
re-enqueued from its cursor — 12 files on disk, nothing written twice, and
exactly `12 − completed` writes in the second run.

## The environment finding

The permission test failed, and the cause was **the test environment, not the
product**: this container runs as root, and root bypasses `chmod`. The
assertion passed vacuously in the sense that mattered — a denied write was not
denied at all.

Two changes:

- The real assertion now uses **ENOTDIR**, not EACCES: writing beneath a
  regular file is refused by the kernel for **every** user, so it means the
  same thing whoever runs the suite.
- The EACCES case is kept but guarded with `it.skipIf(process.getuid?.() === 0)`,
  so it runs for a normal user and is honestly reported as skipped otherwise.

This is the same failure shape as the surviving mutations catalogued in file
17: an assertion that cannot fail is worse than no assertion, and running as
root silently converts one into the other.

## P1 conformance holds on a real filesystem

Files narrow to the file variant with real size and mtime; directories narrow
to exactly `{ kind: "directory" }`; and a **real zero-byte file** is
`{ kind: "file", size: 0, … }` rather than being mistaken for a directory —
the falsy trap, now confirmed against something that actually creates inodes.

## Parity

`NodeFilesApi` needs no registry special case: it declares the same capability
surface as mem (`stat: { size: true, mtime: true }`, all three sort columns),
and `canWatch()` is false for it exactly as for everything else — the hook
exists, nothing implements it, and that is true of a real filesystem adapter
too.

Deterministic enumeration also holds against real `readdir()` order: two runs
over the same tree produce the identical sequence
(`/src/alpha.txt`, `/src/sub/deep/x.txt`, `/src/zeta.txt`), which is what makes
the P4 cursor comparison sound outside mem.

## Mutations run

Re-run against the real adapter, since a mutation that dies on mem may live on
disk:

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | partial target left behind on a real write failure | 1 |
| M2 | enumeration order left to `readdir()` | 2 |
| M3 | resume ignores the cursor | 1 |
| M4 | move deletes the source before the write | 1 |

## What is still unobserved

- **Browser adapters**: OPFS and File System Access — permission prompts,
  revoked handles, and the `showDirectoryPicker` path. These need a browser
  runner (Vitest + Playwright) and are folded into D2/D3 rather than faked here.
- **Remote latency and rate limits**: no credentials available in this
  environment. The per-storage `batchSize` and `pollMs` knobs exist for it
  (C0, C4); nothing yet exercises them against a real remote.

Both are recorded as gaps rather than quietly assumed.

## Next

**D1 — UI protocol.** `fm-ui` is still empty. The rung brings the four UI
commands with typed models, the microtask-settle contract from P0, and the rule
that every handler rejects its outstanding commands on dispose — before
D1.5 (the conflict dialog end to end) and D2 (the React panel).

