import { type Chart, startMachine } from "@kit/machine";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

const chart: Chart = {
  key: "m",
  transitions: [
    ["", "*", "idle"],
    ["idle", "go", "busy"],
    ["busy", "done", "idle"],
    ["busy", "abort", "idle"],
  ],
  states: [{ key: "idle" }, { key: "busy" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("@kit/machine", () => {
  it("handlers run after send returns, never inside the caller", async () => {
    const log: string[] = [];
    const m = startMachine(
      chart,
      { busy: () => void log.push("enter busy") },
      {
        log: newRecordingLogger().logger,
        name: "m",
      },
    );
    await m.idle();
    m.send("go");
    log.push("send returned");
    await m.idle();
    expect(log).toEqual(["send returned", "enter busy"]);
  });

  it("a task's continuation runs only while its state is active", async () => {
    const work = deferred<number>();
    const seen: unknown[] = [];
    let aborted = false;
    const m = startMachine(
      chart,
      {
        busy: ({ task }) =>
          task(
            (signal) => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
              return work.promise;
            },
            (r) => {
              seen.push(r);
              return "done";
            },
          ),
      },
      { log: newRecordingLogger().logger, name: "m" },
    );
    m.send("go");
    await m.idle();
    m.send("abort"); // leaves busy before the work settles
    await m.idle();
    work.resolve(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
    expect(aborted).toBe(true);
    expect(m.states()).toEqual(["m", "idle"]);
  });

  it("after stop: continuations dropped, sends ignored, every state exited", async () => {
    const work = deferred<number>();
    const writes: string[] = [];
    const m = startMachine(
      chart,
      {
        busy: ({ task }) => {
          task(
            () => work.promise,
            () => {
              writes.push("late write");
              return "done";
            },
          );
          return () => writes.push("exit busy");
        },
      },
      { log: newRecordingLogger().logger, name: "m" },
    );
    m.send("go");
    await m.idle();
    await m.stop();
    work.resolve(1);
    m.send("go");
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toEqual(["exit busy"]);
    expect(m.states()).toEqual([]);
  });

  it("a throwing handler is logged at error through the logger, not console", async () => {
    const { logger, calls } = newRecordingLogger();
    const m = startMachine(
      chart,
      {
        busy: () => {
          throw new Error("boom");
        },
      },
      { log: logger, name: "m" },
    );
    m.send("go");
    await m.idle();
    expect(calls.filter((c) => c.level === "error")).toHaveLength(1);
  });

  it("a failing task reaches its continuation as a result, logged at warn", async () => {
    const { logger, calls } = newRecordingLogger();
    const seen: unknown[] = [];
    const m = startMachine(
      chart,
      {
        busy: ({ task }) =>
          task(
            async () => {
              throw new Error("disk full");
            },
            (r) => {
              seen.push(r.ok ? "ok" : r.message);
              return "done";
            },
          ),
      },
      { log: logger, name: "m" },
    );
    m.send("go");
    await m.idle();
    await new Promise((r) => setTimeout(r, 0));
    await m.idle();
    expect(seen).toEqual(["disk full"]);
    expect(m.states()).toEqual(["m", "idle"]);
    expect(calls.filter((c) => c.level === "warn")).toHaveLength(1);
  });
});
