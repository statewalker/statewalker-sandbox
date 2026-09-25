import { type ConflictDialogModel, createConflictResolver } from "@fm/app";
import { JobModel, runCopyJob } from "@fm/core";
import { ViewAdapter } from "@fm/ui";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/* Ported: the packages live under `lib/` in this app, not `packages/`. */
const FM_SRC = new URL("../../lib/", import.meta.url).pathname;

/**
 * D1.5 — engine → command bus → view → answer → engine, with no test doubles
 * in the middle. This is an INTEGRATION suite and lives outside the packages,
 * because it deliberately spans all three layers.
 */

const read = async (api: MemFilesApi, path: string) => {
  let text = "";
  for await (const c of api.read(path)) text += new TextDecoder().decode(c);
  return text;
};

describe("D1.5 · the conflict dialog, end to end", () => {
  let commands: Commands;
  let adapter: ViewAdapter;
  let source: MemFilesApi;
  let target: MemFilesApi;
  let dialogs: { model: ConflictDialogModel; settle: (r: unknown) => void }[];
  let open: number;

  /**
   * Waits for the Nth dialog to actually open rather than assuming a fixed
   * delay produces it: the engine yields, stats the target and serialises the
   * decision before asking, and the number of ticks that takes is not a
   * property the test should encode.
   */
  const waitForDialog = async (n: number) => {
    for (let i = 0; i < 200 && dialogs.length < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(dialogs.length, `dialog ${n} never opened`).toBeGreaterThanOrEqual(n);
  };

  const answer = (resolution: "overwrite" | "skip" | "rename", applyToAll = false) => {
    const dialog = dialogs[dialogs.length - 1];
    dialog.settle({ resolution, applyToAll });
  };

  const runJob = (job: JobModel, batchSize = 2) =>
    runCopyJob({
      operation: "copy",
      source: { uri: "mem://a", api: source },
      target: { uri: "mem://b", api: target, path: "/dst" },
      roots: ["/src"],
      batchSize,
      job,
      onConflict: createConflictResolver(commands),
    });

  beforeEach(() => {
    commands = new Commands();
    dialogs = [];
    open = 0;
    adapter = new ViewAdapter(commands, {
      conflict: ((view: { model: ConflictDialogModel; settle: (r: unknown) => void }) => {
        dialogs.push(view);
        open++;
        // Only one conflict dialog may ever be on screen: the engine serialises
        // decisions, and a second one here would mean it stopped.
        expect(open).toBe(1);
        return () => {
          open--;
        };
      }) as never,
    });
    source = new MemFilesApi({
      initialFiles: { "/src/a.txt": "new-a", "/src/b.txt": "new-b", "/src/c.txt": "new-c" },
    });
    target = new MemFilesApi({
      initialFiles: { "/dst/a.txt": "old-a", "/dst/b.txt": "old-b", "/dst/c.txt": "old-c" },
    });
  });

  it("shows a dialog carrying the real source and target paths", async () => {
    const job = new JobModel("j");
    const run = runJob(job, 1);
    await waitForDialog(1);

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].model.path).toBe("/src/a.txt");
    expect(dialogs[0].model.target).toBe("/dst/a.txt");

    answer("overwrite", true);
    await run;
    expect(await read(target, "/dst/a.txt")).toBe("new-a");
  });

  it("asks exactly ONCE for fifty conflicts when the user applies to all", async () => {
    const files: Record<string, string> = {};
    const existing: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      files[`/src/f${i}.txt`] = "new";
      existing[`/dst/f${i}.txt`] = "old";
    }
    source = new MemFilesApi({ initialFiles: files });
    target = new MemFilesApi({ initialFiles: existing });

    const job = new JobModel("j");
    const run = runJob(job, 4);
    await waitForDialog(1);
    answer("skip", true);
    await run;

    expect(dialogs).toHaveLength(1);
    expect(job.status).toBe("done");
    expect(job.skipped).toHaveLength(50);
    expect(await read(target, "/dst/f0.txt")).toBe("old");
  });

  it("honours a different answer per entry when the user does not apply to all", async () => {
    const job = new JobModel("j");
    const run = runJob(job, 1);

    for (const [index, resolution] of (["overwrite", "skip", "rename"] as const).entries()) {
      await waitForDialog(index + 1);
      answer(resolution);
    }
    await run;

    expect(dialogs).toHaveLength(3);
    expect(await read(target, "/dst/a.txt")).toBe("new-a"); // overwritten
    expect(await read(target, "/dst/b.txt")).toBe("old-b"); // skipped
    expect(await read(target, "/dst/c.txt")).toBe("old-c"); // renamed away
    expect(await read(target, "/dst/c (2).txt")).toBe("new-c");
  });

  it("closes the dialog and ends the job when cancelled mid-decision", async () => {
    const job = new JobModel("j");
    const run = runJob(job, 1);
    await waitForDialog(1);
    expect(open).toBe(1);

    job.cancel();
    await run;

    expect(job.status).toBe("cancelled");
    expect(open).toBe(0); // the view is gone, not orphaned over a dead job
    expect(await read(target, "/dst/a.txt")).toBe("old-a");
  });

  it("does not leave a second job waiting on the first job's dialog", async () => {
    const first = new JobModel("j1");
    const firstRun = runJob(first, 1);
    await waitForDialog(1);
    expect(dialogs).toHaveLength(1);

    first.cancel();
    await firstRun;

    const second = new JobModel("j2");
    const secondRun = runJob(second, 1);
    await waitForDialog(2);
    expect(dialogs).toHaveLength(2); // a fresh question, not a stuck one
    answer("skip", true);
    await secondRun;
    expect(second.status).toBe("done");
  });

  it("fails the job reportably when no view layer can show the dialog", async () => {
    // Without a renderer nothing claims the command. Overwriting silently
    // because the UI is missing would be the worst possible default.
    adapter.dispose();
    const job = new JobModel("j");
    await runJob(job, 1);

    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/no-handlers|not-claimed/);
    expect(await read(target, "/dst/a.txt")).toBe("old-a");
  });

  it("leaves the engine free of any ui: vocabulary", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const file of readdirSync(`${FM_SRC}fm-core/src`).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(`${FM_SRC}fm-core/src/${file}`, "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*/g,
        "",
      );
      expect(code, file).not.toMatch(/["'`]ui:/);
    }
  });
});
