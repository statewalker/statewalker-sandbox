import { join } from "node:path";
import { expect, it } from "vitest";
import { commandFor, discoverTasks } from "../src/index.ts";
import { TASKS_DIR } from "./helpers.ts";

it("finds <name>.<ext> scripts and pairs them with <name>.cleanup.<ext>", async () => {
  const tasks = await discoverTasks(TASKS_DIR);
  const byName = Object.fromEntries(tasks.map((t) => [t.name, t]));

  expect(byName["image-generator"]).toEqual({
    name: "image-generator",
    script: join(TASKS_DIR, "image-generator.mjs"),
    cleanup: join(TASKS_DIR, "image-generator.cleanup.mjs"),
  });
  expect(byName["count"]).toEqual({ name: "count", script: join(TASKS_DIR, "count.py") });
  expect(byName["stream"]).toEqual({ name: "stream", script: join(TASKS_DIR, "stream.ts") });
  // A cleanup script without a job script is not a task.
  expect(byName["broken"]).toBeUndefined();
});

it("picks the launcher from the extension and runs unknown extensions directly", () => {
  expect(commandFor("/t/a.py")).toEqual(["python3", "/t/a.py"]);
  expect(commandFor("/t/a.sh")).toEqual(["bash", "/t/a.sh"]);
  expect(commandFor("/t/a.ts")[0]).toBe("node");
  expect(commandFor("/t/a.ts", { ts: ["tsx"] })).toEqual(["tsx", "/t/a.ts"]);
  expect(commandFor("/t/run")).toEqual(["/t/run"]);
});
