import { afterEach, beforeEach, expect, it } from "vitest";
import { createJobManager, type ProcessJobManager } from "../src/index.ts";
import { task, tempDir } from "./helpers.ts";

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;

beforeEach(async () => {
  dir = await tempDir();
  manager = await createJobManager({ root: dir.path, tasks: [task("stream", "stream.ts")] });
});

afterEach(async () => {
  await manager.close();
  await dir.remove();
});

it("streams the output of a 30-second job while it runs", { timeout: 60_000 }, async () => {
  const started = Date.now();
  const id = await manager.start("stream", { seconds: 30, intervalMs: 1000 });

  const arrivals: { tick: number; at: number; latency: number }[] = [];
  let statusAtFirstTick: string | undefined;
  for await (const m of manager.logs(id)) {
    if (!("message" in m)) continue;
    const { tick, at } = m.message as { tick: number; at: number };
    arrivals.push({ tick, at: Date.now() - started, latency: Date.now() - at });
    statusAtFirstTick ??= await manager.status(id);
  }

  expect(arrivals.map((a) => a.tick)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  expect(statusAtFirstTick).toBe("running");
  // The first line arrives about a second in, not when the job ends.
  expect(arrivals[0].at).toBeLessThan(5_000);
  // Lines arrive spread over the run, each shortly after the script wrote it.
  expect(arrivals.at(-1)!.at - arrivals[0].at).toBeGreaterThan(25_000);
  expect(Math.max(...arrivals.map((a) => a.latency))).toBeLessThan(1_000);
  expect(await manager.status(id)).toBe("done");
});
