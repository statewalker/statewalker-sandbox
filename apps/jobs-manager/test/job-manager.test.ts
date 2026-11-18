import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobManager,
  FileJobStore,
  type JobManagerOptions,
  type ProcessJobManager,
} from "../src/index.ts";
import { collect, shapes, task, tempDir } from "./helpers.ts";

const TASKS = [
  task("quick", "quick.mjs"),
  task("fail", "fail.sh"),
  task("plain-text", "plain-text.sh"),
  task("count", "count.py"),
  task("missing", "does-not-exist.sh"),
  task("sleepy", "sleepy.sh"),
  task("stubborn", "stubborn.sh"),
  task("instant", "instant.sh"),
  task("grandchild", "grandchild.sh"),
];

let dir: Awaited<ReturnType<typeof tempDir>>;
let manager: ProcessJobManager;
const opened: ProcessJobManager[] = [];

/** Opens another manager on the same root; closed after the test. */
async function open(options: Partial<JobManagerOptions> = {}) {
  const m = await createJobManager({ root: dir.path, tasks: TASKS, ...options });
  opened.push(m);
  return m;
}

beforeEach(async () => {
  dir = await tempDir();
  manager = await open();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((m) => m.close()));
  await dir.remove();
});

/** Resolves with the first stdout message of a job. */
async function firstMessage(m: ProcessJobManager, id: string) {
  for await (const message of m.logs(id)) if ("message" in message) return message.message;
  throw new Error("job ended without a message");
}

/** A zombie counts as dead: orphans are only reaped if PID 1 does it, which some containers' init does not. */
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
  } catch {
    return true; // no procfs (macOS): signal 0 succeeded, so it is alive
  }
}

describe("a job that returns immediately", () => {
  it("records pending, running, each stdout line and done", async () => {
    const id = await manager.start("quick", { size: 3 });
    const messages = await collect(manager.logs(id));
    expect(shapes(messages)).toEqual([
      { status: "pending" },
      { status: "running" },
      { status: "running", message: { hello: "world", params: { size: 3 }, jobId: id } },
      { status: "done" },
    ]);
    expect(await manager.status(id)).toBe("done");
  });

  it("stamps messages in strictly increasing order", async () => {
    const id = await manager.start("quick", {});
    const stamps = (await collect(manager.logs(id))).map((m) => m.stamp);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  });

  it("rejects an unknown task", async () => {
    await expect(manager.start("nope", {})).rejects.toMatchObject({ code: "unknown_task" });
  });
});

describe("a job that fails", () => {
  it("records stderr lines while running and the exit code at the end", async () => {
    const id = await manager.start("fail", null);
    const messages = await collect(manager.logs(id));
    expect(shapes(messages)).toEqual([
      { status: "pending" },
      { status: "running" },
      { status: "running", message: { step: 1 } },
      { status: "running", error: { warning: "disk almost full" } },
      { status: "running", error: "boom: something broke" },
      {
        status: "error",
        error: {
          code: "exit",
          exitCode: 3,
          signal: null,
          stderr: '{"warning":"disk almost full"}\nboom: something broke',
        },
      },
    ]);
    expect(await manager.status(id)).toBe("error");
  });

  it("records a script that cannot be started as an error", async () => {
    const id = await manager.start("missing", null);
    const last = (await collect(manager.logs(id))).at(-1)!;
    expect(last.status).toBe("error");
    expect(await manager.status(id)).toBe("error");
  });
});

describe("script output", () => {
  it("keeps non-JSON lines as strings, skips blank lines and flushes an unterminated last line", async () => {
    const id = await manager.start("plain-text", null);
    const messages = (await collect(manager.logs(id))).filter((m) => "message" in m);
    expect(shapes(messages)).toEqual([
      { status: "running", message: "not json at all" },
      { status: "running", message: { last: true } },
    ]);
  });
});

describe("a script that exits at once", () => {
  // Regression: output written before the readers attached was discarded by Node (flushStdio).
  it("never loses its output", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => manager.start("instant", null)));
    for (const id of ids) {
      const messages = (await collect(manager.logs(id))).filter((m) => "message" in m);
      expect(shapes(messages)).toEqual([{ status: "running", message: { ok: true } }]);
    }
  });
});

describe("input stream", () => {
  it("pipes a sync iterable of chunks to the script's stdin", async () => {
    const enc = new TextEncoder();
    const id = await manager.start("count", { mode: "sync" }, [
      enc.encode("a\nb"),
      enc.encode("c\n"),
    ]);
    const message = (await collect(manager.logs(id))).find((m) => "message" in m);
    expect(message).toMatchObject({ message: { bytes: 5, lines: 2, params: { mode: "sync" } } });
  });

  it("pipes an async iterable larger than a pipe buffer", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(10); // 64 KiB of newlines
    async function* input() {
      for (let i = 0; i < 16; i++) yield chunk;
    }
    const id = await manager.start("count", null, input());
    const message = (await collect(manager.logs(id))).find((m) => "message" in m);
    expect(message).toMatchObject({ message: { bytes: 1024 * 1024, lines: 1024 * 1024 } });
  });

  it("gives the script an empty stdin when no input is provided", async () => {
    const id = await manager.start("count", null);
    const message = (await collect(manager.logs(id))).find((m) => "message" in m);
    expect(message).toMatchObject({ message: { bytes: 0 } });
  });
});

describe("interrupt", () => {
  it("stops a running job and every process it started", async () => {
    const id = await manager.start("sleepy", null);
    const { pid, child } = (await firstMessage(manager, id)) as { pid: number; child: number };
    expect(isAlive(child)).toBe(true);

    expect(await manager.interrupt(id)).toBe("interrupted");

    expect(await manager.status(id)).toBe("interrupted");
    const messages = await collect(manager.logs(id));
    expect(messages.at(-1)?.status).toBe("interrupted");
    expect(messages.some((m) => "message" in m && (m.message as { woke?: boolean }).woke)).toBe(
      false,
    );
    await expect.poll(() => isAlive(pid) || isAlive(child)).toBe(false);
  });

  it("escalates to SIGKILL when the script ignores SIGTERM", async () => {
    const m = await open({ killGraceMs: 200 });
    const id = await m.start("stubborn", null);
    await firstMessage(m, id);
    const started = Date.now();
    expect(await m.interrupt(id)).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("leaves a finished job unchanged", async () => {
    const id = await manager.start("quick", null);
    await collect(manager.logs(id));
    expect(await manager.interrupt(id)).toBe("done");
  });

  it("rejects an unknown job", async () => {
    await expect(manager.interrupt("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "unknown_job",
    });
  });
});

describe("concurrency limit", () => {
  it("keeps jobs pending until a slot frees up", async () => {
    const m = await open({ maxConcurrent: 1 });
    const first = await m.start("sleepy", null);
    await firstMessage(m, first);
    const second = await m.start("quick", null);
    expect(await m.status(second)).toBe("pending");

    await m.interrupt(first);
    await collect(m.logs(second));
    expect(await m.status(second)).toBe("done");
  });

  it("interrupts a pending job without ever running it", async () => {
    const m = await open({ maxConcurrent: 1 });
    const first = await m.start("sleepy", null);
    const second = await m.start("quick", null);
    expect(await m.interrupt(second)).toBe("interrupted");
    expect(shapes(await collect(m.logs(second)))).toEqual([
      { status: "pending" },
      { status: "interrupted" },
    ]);
    await m.interrupt(first);
  });
});

describe("list", () => {
  it("lists every job with its task, params and status, filtered on request", async () => {
    const a = await manager.start("quick", { n: 1 });
    const b = await manager.start("fail", { n: 2 });
    await collect(manager.logs(a));
    await collect(manager.logs(b));

    const all = [];
    for await (const info of manager.list()) all.push(info);
    expect(
      all
        .map(({ id, task, params, status }) => ({ id, task, params, status }))
        .sort((x, y) => (x.params as { n: number }).n - (y.params as { n: number }).n),
    ).toEqual([
      { id: a, task: "quick", params: { n: 1 }, status: "done" },
      { id: b, task: "fail", params: { n: 2 }, status: "error" },
    ]);

    const failed = [];
    for await (const info of manager.list({ status: ["error", "interrupted"] }))
      failed.push(info.id);
    expect(failed).toEqual([b]);

    const quick = [];
    for await (const info of manager.list({ task: "quick" })) quick.push(info.id);
    expect(quick).toEqual([a]);
  });
});

describe("logs", () => {
  it("resumes after a given stamp", async () => {
    const id = await manager.start("fail", null);
    const all = await collect(manager.logs(id));
    const rest = await collect(manager.logs(id, all[2].stamp));
    expect(rest).toEqual(all.slice(3));
  });

  it("returns a snapshot of a running job without following when follow is false", async () => {
    const id = await manager.start("sleepy", null);
    await firstMessage(manager, id);
    const snapshot = await collect(manager.logs(id, 0, { follow: false }));
    expect(shapes(snapshot).map((m) => m.status)).toEqual(["pending", "running", "running"]);
  });

  it("stops following when the signal aborts", async () => {
    const id = await manager.start("sleepy", null);
    const controller = new AbortController();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const m of manager.logs(id, 0, { signal: controller.signal })) {
        seen.push(m.status);
        if ("message" in m) controller.abort();
      }
    })();
    await reading;
    expect(seen).toEqual(["pending", "running", "running"]);
    expect(await manager.status(id)).toBe("running");
  });

  it("gives late and early followers the same complete sequence", async () => {
    const id = await manager.start("sleepy", null, undefined);
    const early = collect(manager.logs(id));
    await firstMessage(manager, id);
    const late = collect(manager.logs(id));
    await manager.interrupt(id);
    expect(await late).toEqual(await early);
  });

  it("rejects an unknown job", async () => {
    await expect(
      collect(manager.logs("00000000-0000-0000-0000-000000000000")),
    ).rejects.toMatchObject({
      code: "unknown_job",
    });
  });
});

describe("persistence", () => {
  it("serves finished jobs from a new manager on the same root", async () => {
    const id = await manager.start("fail", { keep: true });
    const before = await collect(manager.logs(id));
    await manager.close();

    const reopened = await open();
    expect(await reopened.info(id)).toMatchObject({
      id,
      task: "fail",
      params: { keep: true },
      status: "error",
    });
    expect(await collect(reopened.logs(id))).toEqual(before);
    const listed = [];
    for await (const info of reopened.list()) listed.push(info.id);
    expect(listed).toEqual([id]);
  });

  it("after a crash, marks running jobs interrupted and runs pending jobs with their input", async () => {
    const crash = spawnSync(process.execPath, [join(import.meta.dirname, "crash.ts"), dir.path], {
      encoding: "utf8",
    });
    expect(crash.signal).toBe("SIGKILL");
    const { running, pending } = JSON.parse(crash.stdout) as { running: string; pending: string };

    // The orphaned script still runs: no manager owns it any more.
    const orphan = (await collect(manager.logs(running, 0, { follow: false }))).find(
      (m) => "message" in m,
    );
    const { pid } = (orphan as unknown as { message: { pid: number } }).message;

    const recovered = await open();
    try {
      expect(await recovered.status(running)).toBe("interrupted");
      expect((await collect(recovered.logs(running))).at(-1)).toMatchObject({
        status: "interrupted",
        error: { code: "restart" },
      });

      const pendingMessages = await collect(recovered.logs(pending));
      expect(pendingMessages.find((m) => "message" in m)).toMatchObject({
        message: { bytes: 8, lines: 2, params: { after: "restart" } },
      });
      expect(await recovered.status(pending)).toBe("done");
      // Regression: the orphaned process group is stopped by recovery, not left running.
      await expect.poll(() => isAlive(pid), { timeout: 3000 }).toBe(false);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });
});

describe("robustness (review findings)", () => {
  it("leaves no trace when storing the input fails", async () => {
    async function* broken() {
      yield new Uint8Array([1, 2, 3]);
      throw new Error("client went away");
    }
    await expect(manager.start("count", null, broken())).rejects.toThrow("client went away");
    const jobs = [];
    for await (const info of manager.list()) jobs.push(info);
    expect(jobs).toEqual([]);
    await manager.close(); // must not hang
  });

  it("kills processes that ignore SIGTERM even after the script itself exited", async () => {
    const m = await open({ killGraceMs: 300 });
    const id = await m.start("grandchild", null);
    const { grandchild } = (await firstMessage(m, id)) as { grandchild: number };
    expect(await m.interrupt(id)).toBe("interrupted");
    await expect.poll(() => isAlive(grandchild), { timeout: 3000 }).toBe(false);
  });

  it("starts despite a torn last line left by a crash, and drops that line", async () => {
    const id = await manager.start("quick", null);
    const complete = await collect(manager.logs(id));
    await manager.close();
    await appendFile(new FileJobStore(dir.path).messagesFile(id), '{"stamp":1,"status":"runn');

    const reopened = await open();
    expect(await collect(reopened.logs(id))).toEqual(complete);
  });

  it("takes the status from the last message when job.json missed the final update", async () => {
    const id = await manager.start("quick", null);
    const complete = await collect(manager.logs(id));
    await manager.close();
    const store = new FileJobStore(dir.path);
    await store.writeInfo({ ...(await store.readInfo(id))!, status: "running" });

    const reopened = await open();
    expect(await reopened.status(id)).toBe("done");
    expect(await collect(reopened.logs(id))).toEqual(complete);
  });
});
