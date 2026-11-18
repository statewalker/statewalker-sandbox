# Parallel run report: 36 jobs, 12 tasks, three languages

_Measured on 18 November 2026: Node 22.23.5, Python 3.13.18, Bash 5.2.21, 4 cores of an Intel
Xeon @ 2.30 GHz, Linux x64. Raw data: [`reports/parallel-2026-11-18.json`](reports/parallel-2026-11-18.json).
Regenerate with `npm run report -- out.json`._

## What was run

Twelve tasks, four per language. Each covers a different behaviour:

| Behaviour | Python | TypeScript | Bash |
| --- | --- | --- | --- |
| Compute from params | `py-primes`: sieve, 10 progress lines | `ts-fib`: BigInt Fibonacci, one line per value | `sh-exit`: exits with `params.code` (0, 2, 42) |
| Transform stdin | `py-uppercase` | `ts-wordfreq`: top-3 words | `sh-checksum`: SHA-256 of up to 1 MiB; `sh-lines`: line lengths |
| Fail | `py-crash`: uncaught `ValueError`, exit 1 | `ts-throw`: uncaught `Error`, exit 1 | `sh-exit` with code 2 or 42 |
| Long-running stream | `py-ticks` | `ts-ticks` | `sh-ticks` |

Each task runs three times with different parameters or input, which gives **36 jobs**. All 36
start at once, and the run waits for every one to finish.

**How results are checked.** Each job's expected outcome comes from an independent source, never
recomputed the way the script does it:

- the published prime counts (5133, 9592 and 17984);
- Fibonacci literals;
- SHA-256 from `node:crypto`, checking the bash script's `sha256sum`;
- hand-written expected word rankings and line lengths.

A deliberate mutation (one wrong prime count, one wrong error text) makes the suite fail with
exactly those four jobs named, so the checks are not vacuous.

## Results

| Mode | maxConcurrent | Wall time | Max running at once | Jobs correct | Messages |
| --- | ---: | ---: | ---: | ---: | ---: |
| API | 1 | 22.1 s | 1 | 36 / 36 | 433 |
| API | 4 | 7.2 s | 4 | 36 / 36 | 433 |
| API | 8 | 4.6 s | 8 | 36 / 36 | 433 |
| API | 16 | 2.7 s | 16 | 36 / 36 | 433 |
| API | 36 | 2.8 s | 36 | 36 / 36 | 433 |
| REST + SSE | 8 | 4.8 s | 8 | 36 / 36 | 433 |

"Max running at once" is rebuilt from the message stamps: each job runs from its first
`running` message to its final message.

**Average run time per task, in milliseconds** (from spawn to final message):

| Task | Alone (limit 1) | All 36 at once |
| --- | ---: | ---: |
| `sh-lines` / `sh-checksum` / `sh-exit` | 2 / 5 / 5 | 80 / 96 / 185 |
| `py-uppercase` / `py-primes` / `py-crash` | 18 / 35 / 37 | 137 / 311 / 301 |
| `ts-wordfreq` / `ts-throw` / `ts-fib` | 56 / 61 / 64 | 174 / 277 / 318 |
| `*-ticks` (sleep-bound, 2.0–2.5 s by design) | 2321–2360 | 2344–2457 |

## Findings

1. **Correctness held at every concurrency level.** All six runs completed all 36 jobs, with the
   same 433 messages, the right final statuses, and the expected stdout and stderr content. That
   includes the three failure modes: Python traceback, Node stack trace, and Bash exit codes.
2. **The concurrency limit is both held and reached.** The largest number of jobs running at once
   equals `maxConcurrent` in every run. At limit 1, the queue wait grows to 22 s for the last job,
   which is the sum of all the others.
3. **Wall time follows the slots until the longest job dominates.** Limit 1 gives 22.1 s, 4 gives
   7.2 s, 8 gives 4.6 s and 16 gives 2.7 s. Beyond 16 there is no gain: the floor is the slowest
   tick job (about 2.5 s), plus start-up under contention.
4. **Start-up cost differs by language.** Measured alone, a Bash job takes about 2–5 ms, Python
   about 20–40 ms, and TypeScript about 60 ms. Node's type stripping and module loading dominate
   the short TS jobs.
5. **Contention hits short jobs, not sleeping ones.** With 36 processes on 4 cores, short jobs
   take 5–20× longer, while the sleep-bound tick jobs stay within 5 % of their solo time. A
   `maxConcurrent` around 2–4× the core count suits mixed workloads. CPU-heavy tasks would want it
   near the core count.
6. **REST costs little.** Submitting 36 jobs over HTTP and following each over its own SSE stream
   took 4.8 s, against 4.6 s in process. Every SSE stream ended right after the final status.

## Tests that cover this

`test/parallel.test.ts` runs the same scenario as the report, in four tests:

- limit 4, and limit 12: every result is correct, the limit is held and reached, and some jobs
  waited;
- limit 36: Python, TypeScript and Bash jobs all overlap the Bash ticking job;
- REST with limit 8: SSE results are identical.

The whole suite has 53 tests. It takes about 30 s of wall time, because test files run in parallel and two tests deliberately run a 30 s job.
