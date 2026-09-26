import { readdirSync, readFileSync } from "node:fs";
import { type ConflictResolution, JobModel, type JobSpec, runCopyJob } from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/* Ported: the packages live under `lib/` in this app, not `packages/`. */
const FM_SRC = new URL("../../lib/", import.meta.url).pathname;

/** P5 — conflicts resolve without the core knowing anything about UI. */

const read = async (api: MemFilesApi, path: string) => {
  let text = "";
  for await (const c of api.read(path)) text += new TextDecoder().decode(c);
  return text;
};

describe("P5 · conflicts", () => {
  let source: MemFilesApi;
  let target: MemFilesApi;
  let job: JobModel;

  const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
    operation: "copy",
    source: { uri: "mem://a", api: source },
    target: { uri: "mem://b", api: target, path: "/dst" },
    roots: ["/src"],
    batchSize: 2,
    job,
    ...over,
  });

  beforeEach(() => {
    source = new MemFilesApi({
      initialFiles: { "/src/a.txt": "new-a", "/src/b.txt": "new-b", "/src/c.txt": "new-c" },
    });
    target = new MemFilesApi({
      initialFiles: { "/dst/a.txt": "old-a", "/dst/b.txt": "old-b" },
    });
    job = new JobModel("j");
  });

  it("asks only about entries that actually conflict", async () => {
    const asked: string[] = [];
    await runCopyJob(
      spec({
        onConflict: async (entry) => {
          asked.push(entry.path);
          return { resolution: "overwrite", applyToAll: false };
        },
      }),
    );
    expect(asked.sort()).toEqual(["/src/a.txt", "/src/b.txt"]); // c.txt does not exist yet
  });

  it("honours overwrite, skip and rename per entry", async () => {
    const answers: Record<string, ConflictResolution> = {
      "/src/a.txt": { resolution: "overwrite", applyToAll: false },
      "/src/b.txt": { resolution: "skip", applyToAll: false },
    };
    await runCopyJob(spec({ batchSize: 1, onConflict: async (e) => answers[e.path] }));

    expect(await read(target, "/dst/a.txt")).toBe("new-a");
    expect(await read(target, "/dst/b.txt")).toBe("old-b");
    expect(await read(target, "/dst/c.txt")).toBe("new-c");
  });

  it("renames rather than overwriting when asked", async () => {
    await runCopyJob(
      spec({
        batchSize: 1,
        onConflict: async () => ({ resolution: "rename", applyToAll: true }),
      }),
    );
    expect(await read(target, "/dst/a.txt")).toBe("old-a");
    expect(await read(target, "/dst/a (2).txt")).toBe("new-a");
  });

  it("caches applyToAll: 700 conflicts are not asked 700 times", async () => {
    const files: Record<string, string> = {};
    const existing: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      files[`/src/f${i}.txt`] = "new";
      existing[`/dst/f${i}.txt`] = "old";
    }
    source = new MemFilesApi({ initialFiles: files });
    target = new MemFilesApi({ initialFiles: existing });

    let asked = 0;
    await runCopyJob(
      spec({
        batchSize: 4,
        onConflict: async () => {
          asked++;
          return { resolution: "skip", applyToAll: true };
        },
      }),
    );
    expect(asked).toBe(1);
    expect(await read(target, "/dst/f0.txt")).toBe("old");
  });

  it("uses a plain conflictPolicy when no callback is supplied", async () => {
    await runCopyJob(spec({ conflictPolicy: "skip" }));
    expect(await read(target, "/dst/a.txt")).toBe("old-a");
    expect(await read(target, "/dst/c.txt")).toBe("new-c");
  });

  it("interrupts a pending decision when the job is cancelled", async () => {
    let aborted = false;
    const run = runCopyJob(
      spec({
        batchSize: 1,
        onConflict: (_entry, signal) =>
          new Promise((resolve, reject) => {
            // A dialog that is never answered by the user.
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("decision aborted"));
            });
          }),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    job.cancel();
    await run;

    expect(aborted).toBe(true);
    expect(job.status).toBe("cancelled");
    expect(await read(target, "/dst/a.txt")).toBe("old-a"); // untouched
  });

  it("records skipped entries as job errors, not as failures", async () => {
    await runCopyJob(spec({ conflictPolicy: "skip" }));
    expect(job.status).toBe("done");
    expect(job.skipped).toEqual(["/src/a.txt", "/src/b.txt"]);
  });

  it("keeps fm-core free of the ui:* vocabulary", () => {
    const files = readdirSync(`${FM_SRC}fm-core/src`).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const text = readFileSync(`${FM_SRC}fm-core/src/${file}`, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments
      expect(code, `${file} must not reference ui:* commands`).not.toMatch(/ui:/);
      expect(code, `${file} must not import from the app layer`).not.toMatch(/from "\.\.\/app/);
    }
  });
});
