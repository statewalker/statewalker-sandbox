// The rolldown build (tsdown) is what `bin` and `jobs` point at: check it runs, not just the source.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const DIST = join(import.meta.dirname, "../dist");

it("builds an executable CLI bundle that prints its usage", () => {
  const help = spawnSync(process.execPath, [join(DIST, "cli.mjs"), "help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toMatch(/jobs start <task>/);
});

it("builds the library entry with type declarations", async () => {
  const lib = (await import(join(DIST, "index.mjs"))) as Record<string, unknown>;
  for (const name of [
    "createJobManager",
    "createJobsHandler",
    "serve",
    "JobsClient",
    "verifyJob",
    "discoverTasks",
  ]) {
    expect(typeof lib[name], name).toBe("function");
  }
  expect(existsSync(join(DIST, "index.d.mts"))).toBe(true);
});
