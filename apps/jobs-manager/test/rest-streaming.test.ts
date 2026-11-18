import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createJobManager,
  createJobsHandler,
  type ProcessJobManager,
  type Server,
  serve,
} from "../src/index.ts";
import { task, tempDir } from "./helpers.ts";
import { readSse } from "./rest-helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await tempDir();
  manager = await createJobManager({ root: dir.path, tasks: [task("stream", "stream.ts")] });
  server = await serve(createJobsHandler(manager, { basePath: "/api", keepAliveMs: 2_000 }), {
    port: 0,
    host: "127.0.0.1",
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await manager.close();
  await dir.remove();
});

it("delivers each line of a 30-second job over SSE as it is produced", {
  timeout: 60_000,
}, async () => {
  const started = Date.now();
  const submitted = await fetch(`${base}/api/tasks/stream/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds: 30, intervalMs: 1000 }),
  });
  const { eventsUrl } = (await submitted.json()) as { eventsUrl: string };
  expect(eventsUrl).toMatch(/^\/api\/jobs\/.+\/events$/);

  const arrivals: number[] = [];
  const events = await readSse(await fetch(`${base}${eventsUrl}`), (e) => {
    if ("message" in e.data) arrivals.push(Date.now() - started);
    return false;
  });

  expect(events.filter((e) => "message" in e.data)).toHaveLength(30);
  expect(events.at(-1)!.data.status).toBe("done");
  expect(arrivals[0]).toBeLessThan(5_000);
  expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThan(25_000);
  // No gap much longer than the script's 1 s interval: nothing is buffered until the end.
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  expect(Math.max(...gaps)).toBeLessThan(2_000);
});
