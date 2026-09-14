import { LogsController } from "@logs/app";
import { getLogger } from "@statewalker/shared-logger";
import { type LogRecord, loggerBackendsSlot } from "@sys";
import { describe, expect, it, vi } from "vitest";
import { newTestContext } from "../support/context.js";
import { newRecordingLogger } from "../support/logging.js";

describe("B2 · logs controller", () => {
  it("activation overwrites the context's logger; dispose removes it", async () => {
    const { ctx } = newTestContext();
    const before = getLogger(ctx);
    const logs = new LogsController({ fallback: newRecordingLogger().logger });
    logs.activate(ctx);
    const installed = getLogger(ctx);
    expect(installed).not.toBe(before);
    await logs.dispose();
    expect(getLogger(ctx), "the key was removed, so the default is created afresh").not.toBe(
      installed,
    );
  });

  it("uses the fallback until a backend is contributed, then the backends — as they come and go", async () => {
    const { ctx, slots } = newTestContext();
    const fallback = newRecordingLogger();
    const logs = new LogsController({ fallback: fallback.logger });
    logs.activate(ctx);
    const log = getLogger(ctx);
    log.info("before");
    const records: LogRecord[] = [];
    const off = slots.provide(loggerBackendsSlot, { write: (r) => records.push(r) });
    log.info("during");
    off();
    log.info("after");
    expect(fallback.calls.map((c) => c.args[0])).toEqual(["before", "after"]);
    expect(records.map((r) => r.args[0])).toEqual(["during"]);
    await logs.dispose();
  });

  it("with no fallback option and no backend, a record reaches the standard console logger", async () => {
    const { ctx } = newTestContext();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logs = new LogsController();
    logs.activate(ctx);
    getLogger(ctx).child({ module: "demo" }).info("to the console", { n: 1 });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual(expect.arrayContaining(["to the console", { n: 1 }]));
    info.mockRestore();
    await logs.dispose();
  });

  it("picks up a backend contributed before it activated", async () => {
    const { ctx, slots } = newTestContext();
    const records: LogRecord[] = [];
    slots.provide(loggerBackendsSlot, { write: (r) => records.push(r) });
    const logs = new LogsController({ fallback: newRecordingLogger().logger });
    logs.activate(ctx);
    getLogger(ctx).info("late activation");
    expect(records).toHaveLength(1);
    await logs.dispose();
  });

  it("PINNED CONSTRAINT: a logger resolved before activation keeps writing to the old logger", async () => {
    const { ctx, slots, recorder } = newTestContext();
    const early = getLogger(ctx); // the recording logger the context started with
    const records: LogRecord[] = [];
    slots.provide(loggerBackendsSlot, { write: (r) => records.push(r) });
    const logs = new LogsController({ fallback: newRecordingLogger().logger });
    logs.activate(ctx);
    early.info("too early");
    expect(records, "the backends never see it").toEqual([]);
    expect(recorder.calls.map((c) => c.args[0])).toEqual(["too early"]);
    await logs.dispose();
  });
});
