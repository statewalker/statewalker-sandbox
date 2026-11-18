// Shared by the parallel tests and scripts/parallel-report.ts: 36 jobs over 12 tasks in three
// languages, each with an expected outcome taken from an independent source (known values, or
// node:crypto for the checksum the bash task computes with sha256sum).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobMessage, JobStatus, Json, TaskDefinition } from "../../src/types.ts";

export const PARALLEL_DIR = fileURLToPath(new URL("../fixtures/parallel/", import.meta.url));

export type Lang = "python" | "typescript" | "bash";

export type JobSpec = {
  label: string;
  task: string;
  lang: Lang;
  params: Json;
  input?: Uint8Array;
  status: JobStatus;
  /** Returns a description of what is wrong, or undefined when the job did what it should. */
  check: (messages: JobMessage[]) => string | undefined;
};

const FILES: Record<string, string> = {
  "py-primes": "py-primes.py",
  "py-uppercase": "py-uppercase.py",
  "py-crash": "py-crash.py",
  "py-ticks": "py-ticks.py",
  "ts-fib": "ts-fib.ts",
  "ts-wordfreq": "ts-wordfreq.ts",
  "ts-throw": "ts-throw.ts",
  "ts-ticks": "ts-ticks.ts",
  "sh-checksum": "sh-checksum.sh",
  "sh-lines": "sh-lines.sh",
  "sh-exit": "sh-exit.sh",
  "sh-ticks": "sh-ticks.sh",
};

export const PARALLEL_TASKS: TaskDefinition[] = Object.entries(FILES).map(([name, file]) => ({
  name,
  script: join(PARALLEL_DIR, file),
}));

const langOf = (task: string): Lang =>
  task.startsWith("py-") ? "python" : task.startsWith("ts-") ? "typescript" : "bash";
const enc = (s: string) => new TextEncoder().encode(s);
const payloads = (ms: JobMessage[]) =>
  ms.flatMap((m) => ("message" in m && m.message !== undefined ? [m.message] : []));
const final = (ms: JobMessage[]) => ms.at(-1);
const same = (actual: unknown, expected: unknown, what: string) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? undefined
    : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;

function failure(exitCode: number, stderrIncludes: string, first: Json) {
  return (ms: JobMessage[]) => {
    const end = final(ms) as { error?: { exitCode?: number; stderr?: string } };
    return (
      same(payloads(ms), [first], "stdout") ??
      same(end.error?.exitCode, exitCode, "exit code") ??
      (end.error?.stderr?.includes(stderrIncludes) ? undefined : `stderr lacks "${stderrIncludes}"`)
    );
  };
}

function ticks(count: number, lang: Lang) {
  return (ms: JobMessage[]) =>
    same(
      payloads(ms),
      Array.from({ length: count }, (_, i) => ({ tick: i + 1, lang })),
      "ticks",
    );
}

function spec(
  task: string,
  params: Json,
  status: JobStatus,
  check: JobSpec["check"],
  input?: Uint8Array,
  label?: string,
): JobSpec {
  return {
    label: label ?? `${task} ${JSON.stringify(params)}`,
    task,
    lang: langOf(task),
    params,
    input,
    status,
    check,
  };
}

const big = new Uint8Array(1024 * 1024).map((_, i) => (i * 31) % 251); // 1 MiB of varied bytes
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const PARALLEL_JOBS: JobSpec[] = [
  // Python
  ...[
    [50_000, 5133],
    [100_000, 9592],
    [200_000, 17984],
  ].map(([limit, primes]) =>
    spec("py-primes", { limit }, "done", (ms) => {
      const out = payloads(ms) as { progress?: number; primes?: number }[];
      return (
        same(out.at(-1), { primes }, "result") ??
        (out.filter((o) => o.progress !== undefined).length >= 9
          ? undefined
          : "too few progress lines")
      );
    }),
  ),
  ...["alpha\nbeta\n", "one line, no newline", "x\ny\nz\n"].map((text) =>
    spec(
      "py-uppercase",
      null,
      "done",
      (ms) =>
        same(
          payloads(ms),
          text
            .split("\n")
            .filter(Boolean)
            .map((t, i) => ({ line: i + 1, text: t.toUpperCase() })),
          "lines",
        ),
      enc(text),
      `py-uppercase ${JSON.stringify(text)}`,
    ),
  ),
  ...[1, 2, 3].map((i) =>
    spec("py-crash", { i }, "error", failure(1, "ValueError: bad input", { step: 1 })),
  ),
  ...[
    [5, 400],
    [8, 300],
    [10, 250],
  ].map(([n, interval]) =>
    spec("py-ticks", { ticks: n, intervalMs: interval }, "done", ticks(n, "python")),
  ),

  // TypeScript
  ...(
    [
      [10, "55"],
      [50, "12586269025"],
      [90, "2880067194370816120"],
    ] as const
  ).map(([n, fib]) =>
    spec("ts-fib", { n }, "done", (ms) => {
      const out = payloads(ms) as { n: number; fib: string }[];
      return same(out.length, n, "line count") ?? same(out.at(-1), { n, fib }, "last value");
    }),
  ),
  ...(
    [
      [
        "the cat and the hat and the bat",
        [
          { word: "the", count: 3 },
          { word: "and", count: 2 },
          { word: "bat", count: 1 },
        ],
      ],
      [
        "b a b a b c",
        [
          { word: "b", count: 3 },
          { word: "a", count: 2 },
          { word: "c", count: 1 },
        ],
      ],
      [
        "Go go GO stop",
        [
          { word: "go", count: 3 },
          { word: "stop", count: 1 },
        ],
      ],
    ] as const
  ).map(([text, expected]) =>
    spec(
      "ts-wordfreq",
      { top: 3 },
      "done",
      (ms) => same(payloads(ms), expected, "ranking"),
      enc(text),
      `ts-wordfreq ${JSON.stringify(text)}`,
    ),
  ),
  ...[1, 2, 3].map((i) =>
    spec("ts-throw", { i }, "error", failure(1, "Error: ts failure", { step: 1 })),
  ),
  ...[
    [5, 400],
    [8, 300],
    [10, 250],
  ].map(([n, interval]) =>
    spec("ts-ticks", { ticks: n, intervalMs: interval }, "done", ticks(n, "typescript")),
  ),

  // Bash
  ...(
    [
      ["hello\n", enc("hello\n")],
      ["empty", new Uint8Array(0)],
      ["1 MiB", big],
    ] as const
  ).map(([name, bytes]) =>
    spec(
      "sh-checksum",
      null,
      "done",
      (ms) => same(payloads(ms), [{ sha256: sha(bytes) }], "checksum"),
      bytes,
      `sh-checksum ${name}`,
    ),
  ),
  ...["abc\nde\n", "single", "\nxyz\n"].map((text) =>
    spec(
      "sh-lines",
      null,
      "done",
      (ms) =>
        same(
          payloads(ms),
          text
            .replace(/\n$/, "")
            .split("\n")
            .map((l, i) => ({ n: i + 1, length: l.length })),
          "lengths",
        ),
      enc(text),
      `sh-lines ${JSON.stringify(text)}`,
    ),
  ),
  ...[0, 2, 42].map((code) =>
    spec("sh-exit", { code }, code === 0 ? "done" : "error", (ms) => {
      const end = final(ms) as { error?: { exitCode?: number } };
      return (
        same(payloads(ms), [{ exiting: code }], "stdout") ??
        (code === 0 ? undefined : same(end.error?.exitCode, code, "exit code"))
      );
    }),
  ),
  ...[
    [5, 400],
    [8, 300],
    [10, 250],
  ].map(([n, interval]) =>
    spec("sh-ticks", { ticks: n, intervalMs: interval }, "done", ticks(n, "bash")),
  ),
];

export type Timeline = { created: number; started?: number; finished: number; status: JobStatus };

/** When a job was accepted, when its process started, when it finished: read from its message stamps. */
export function timeline(messages: JobMessage[]): Timeline {
  const started = messages.find(
    (m) => m.status === "running" && !("message" in m) && !("error" in m),
  )?.stamp;
  const end = messages.at(-1)!;
  return { created: messages[0].stamp, started, finished: end.stamp, status: end.status };
}

/** Largest number of jobs whose processes were running at the same instant. */
export function maxOverlap(timelines: Timeline[]): number {
  const edges = timelines
    .filter((t) => t.started !== undefined)
    .flatMap((t) => [
      [t.started!, 1],
      [t.finished, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at the same stamp
  let current = 0;
  let max = 0;
  for (const [, delta] of edges) {
    current += delta;
    max = Math.max(max, current);
  }
  return max;
}
