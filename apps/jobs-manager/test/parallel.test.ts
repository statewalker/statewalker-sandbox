import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  createJobsHandler,
  type JobMessage,
  type ProcessJobManager,
  type Server,
  serve,
} from "../src/index.ts";
import { collect, tempDir } from "./helpers.ts";
import { maxOverlap, PARALLEL_JOBS, PARALLEL_TASKS, timeline } from "./parallel/scenario.ts";
import { readSse } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager | undefined;
let server: Server | undefined;

beforeEach(async () => {
  dir = await tempDir();
});

afterEach(async () => {
  await server?.close();
  await manager?.close();
  server = manager = undefined;
  await dir.remove();
});

/** Every job reached its expected status and produced its expected output. */
function verify(results: JobMessage[][]) {
  const problems = PARALLEL_JOBS.flatMap((spec, i) => {
    const messages = results[i];
    const status = messages.at(-1)?.status;
    if (status !== spec.status) return [`${spec.label}: status ${status}, expected ${spec.status}`];
    const problem = spec.check(messages);
    return problem ? [`${spec.label}: ${problem}`] : [];
  });
  expect(problems).toEqual([]);
}

describe("36 jobs of 12 tasks in Python, TypeScript and Bash, started at once", () => {
  for (const limit of [4, 12]) {
    it(`all produce their expected results with at most ${limit} running at a time`, {
      timeout: 90_000,
    }, async () => {
      manager = await createJobManager({
        root: dir.path,
        tasks: PARALLEL_TASKS,
        maxConcurrent: limit,
      });
      const m = manager;
      const ids = await Promise.all(
        PARALLEL_JOBS.map((s) => m.start(s.task, s.params, s.input ? [s.input] : undefined)),
      );
      const results = await Promise.all(ids.map((id) => collect(m.logs(id))));

      verify(results);
      const timelines = results.map(timeline);
      // The limit holds, and is reached: the jobs really ran side by side.
      expect(maxOverlap(timelines)).toBe(limit);
      // With more jobs than slots, some had to wait in "pending".
      expect(timelines.filter((t) => t.started! - t.created > 100).length).toBeGreaterThan(0);
    });
  }

  it("languages interleave: while a Bash job ticks, Python and TypeScript jobs run too", {
    timeout: 60_000,
  }, async () => {
    manager = await createJobManager({ root: dir.path, tasks: PARALLEL_TASKS, maxConcurrent: 36 });
    const m = manager;
    const ids = await Promise.all(
      PARALLEL_JOBS.map((s) => m.start(s.task, s.params, s.input ? [s.input] : undefined)),
    );
    const results = await Promise.all(ids.map((id) => collect(m.logs(id))));
    verify(results);

    const timelines = results.map(timeline);
    const bashTicks = PARALLEL_JOBS.findIndex((s) => s.task === "sh-ticks");
    const overlapping = PARALLEL_JOBS.filter(
      (_, i) =>
        timelines[i].started! < timelines[bashTicks].finished &&
        timelines[i].finished > timelines[bashTicks].started!,
    );
    expect(new Set(overlapping.map((s) => s.lang))).toEqual(
      new Set(["python", "typescript", "bash"]),
    );
  });
});

describe("the same 36 jobs over REST", () => {
  it("are submitted and followed over SSE concurrently, with the same results", {
    timeout: 90_000,
  }, async () => {
    manager = await createJobManager({ root: dir.path, tasks: PARALLEL_TASKS, maxConcurrent: 8 });
    server = await serve(createJobsHandler(manager), { port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;

    const submitted = await Promise.all(
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
        expect(response.status).toBe(202);
        return (await response.json()) as { eventsUrl: string };
      }),
    );
    const results = await Promise.all(
      submitted.map(async ({ eventsUrl }) =>
        (await readSse(await fetch(`${base}${eventsUrl}`))).map((e) => e.data),
      ),
    );

    verify(results);
    expect(maxOverlap(results.map(timeline))).toBe(8);
  });
});
