// Runs the 36-job parallel scenario (test/parallel/scenario.ts) at several concurrency limits, in
// process and over REST, and writes the measurements as JSON.
//   node scripts/parallel-report.ts [out.json]
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createJobManager, createJobsHandler, type JobMessage, serve } from "../src/index.ts";
import { maxOverlap, PARALLEL_JOBS, PARALLEL_TASKS, timeline } from "../test/parallel/scenario.ts";
import { readSse } from "../test/rest-helpers.ts";

type JobRow = {
  label: string;
  task: string;
  lang: string;
  status: string;
  expectedStatus: string;
  ok: boolean;
  problem?: string;
  messages: number;
  queuedMs: number;
  runMs: number;
};

type Run = {
  mode: "api" | "rest";
  maxConcurrent: number;
  wallMs: number;
  maxOverlap: number;
  passed: number;
  failed: number;
  messages: number;
  jobs: JobRow[];
};

async function run(mode: "api" | "rest", maxConcurrent: number): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "jobs-report-"));
  const manager = await createJobManager({ root, tasks: PARALLEL_TASKS, maxConcurrent });
  const server =
    mode === "rest"
      ? await serve(createJobsHandler(manager), { port: 0, host: "127.0.0.1" })
      : undefined;
  const base = server ? `http://127.0.0.1:${server.port}` : "";
  const started = performance.now();
  let results: JobMessage[][];
  if (mode === "api") {
    const ids = await Promise.all(
      PARALLEL_JOBS.map((s) => manager.start(s.task, s.params, s.input ? [s.input] : undefined)),
    );
    results = await Promise.all(
      ids.map(async (id) => {
        const out: JobMessage[] = [];
        for await (const m of manager.logs(id)) out.push(m);
        return out;
      }),
    );
  } else {
    const urls = await Promise.all(
      PARALLEL_JOBS.map(async (s) => {
        const params = encodeURIComponent(JSON.stringify(s.params));
        const response = s.input
          ? await fetch(`${base}/tasks/${s.task}/jobs?params=${params}`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: s.input as unknown as BodyInit,
            })
          : await fetch(`${base}/tasks/${s.task}/jobs`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(s.params),
            });
        return ((await response.json()) as { eventsUrl: string }).eventsUrl;
      }),
    );
    results = await Promise.all(
      urls.map(async (u) => (await readSse(await fetch(`${base}${u}`))).map((e) => e.data)),
    );
  }
  const wallMs = performance.now() - started;
  await server?.close();
  await manager.close();
  await rm(root, { recursive: true, force: true });

  const timelines = results.map(timeline);
  const jobs = PARALLEL_JOBS.map((spec, i): JobRow => {
    const t = timelines[i];
    const problem =
      t.status !== spec.status
        ? `status ${t.status}, expected ${spec.status}`
        : spec.check(results[i]);
    return {
      label: spec.label,
      task: spec.task,
      lang: spec.lang,
      status: t.status,
      expectedStatus: spec.status,
      ok: !problem,
      ...(problem ? { problem } : {}),
      messages: results[i].length,
      queuedMs: round(t.started! - t.created),
      runMs: round(t.finished - t.started!),
    };
  });
  return {
    mode,
    maxConcurrent,
    wallMs: round(wallMs),
    maxOverlap: maxOverlap(timelines),
    passed: jobs.filter((j) => j.ok).length,
    failed: jobs.filter((j) => !j.ok).length,
    messages: jobs.reduce((n, j) => n + j.messages, 0),
    jobs,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
const version = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
};

const runs: Run[] = [];
for (const limit of [1, 4, 8, 16, 36]) {
  runs.push(await run("api", limit));
  process.stderr.write(`api   maxConcurrent=${limit}: ${runs.at(-1)!.wallMs} ms\n`);
}
runs.push(await run("rest", 8));
process.stderr.write(`rest  maxConcurrent=8: ${runs.at(-1)!.wallMs} ms\n`);

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    python: version("python3", ["--version"]),
    bash: version("bash", ["--version"]).split("\n")[0],
    cpu: cpus()[0]?.model ?? "unknown",
    cores: availableParallelism(),
    platform: `${process.platform} ${process.arch}`,
  },
  tasks: PARALLEL_TASKS.map((t) => t.name),
  jobsPerRun: PARALLEL_JOBS.length,
  runs,
};

const out = process.argv[2];
if (out) await writeFile(out, JSON.stringify(report, null, 2));

console.log(`| mode | maxConcurrent | wall (s) | max overlap | passed | messages |`);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`);
for (const r of runs) {
  console.log(
    `| ${r.mode} | ${r.maxConcurrent} | ${(r.wallMs / 1000).toFixed(1)} | ${r.maxOverlap} | ${r.passed}/${r.jobs.length} | ${r.messages} |`,
  );
}
